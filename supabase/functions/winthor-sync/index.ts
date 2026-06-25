// ============================================================
// SUPABASE EDGE FUNCTION: winthor-sync v3
// Corrigido com base na documentacao oficial TOTVS TDN
// Principais correcoes:
//   - branchId OBRIGATORIO nos pedidos
//   - Campo data do pedido e "createData" (nao createDate)
//   - Paginacao via hasNext (nao items.length < pageSize)
//   - Suporte a winthor_filial na tabela empresas
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Helper para fazer requisicoes com timeout para evitar travamentos
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 30000
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal
    })
    return res
  } finally {
    clearTimeout(timer)
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !supabaseKey) {
      throw new Error('SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY nao configuradas')
    }

    const supabase = createClient(supabaseUrl, supabaseKey)

    const { data: empresas, error: errEmpresas } = await supabase
      .from('empresas')
      .select('id, winthor_url, winthor_login, winthor_senha, winthor_filial')
      .not('winthor_url', 'is', null)

    if (errEmpresas) throw errEmpresas
    if (!empresas || empresas.length === 0) {
      return new Response(
        JSON.stringify({ message: 'Nenhuma empresa configurada' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
      )
    }

    const resultados = []
    for (const empresa of empresas) {
      const resultado = await syncEmpresa(supabase, empresa)
      resultados.push(resultado)
    }

    return new Response(
      JSON.stringify({ success: true, resultados }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )
  } catch (error) {
    const err = error as any
    return new Response(
      JSON.stringify({ error: err.message || String(error) }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})

// ============================================================
// HELPER: busca paginada usando hasNext (padrao TOTVS)
// ============================================================
async function fetchAllPages(
  baseUrl: string,
  endpoint: string,
  token: string,
  extraParams: Record<string, any> = {}
): Promise<any[]> {
  const allItems: any[] = []
  let page = 1
  const pageSize = 1000

  while (true) {
    const url = new URL(`${baseUrl}${endpoint}`)
    const params: Record<string, any> = { ...extraParams, page, pageSize }
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
    })

    const res = await fetchWithTimeout(url.toString(), {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }, 30000)

    if (!res.ok) {
      const body = await res.text()
      console.error(`[fetchAllPages] Erro ${res.status} em ${endpoint} pagina ${page}: ${body.substring(0, 300)}`)
      break
    }

    const raw = await res.json()

    // API retorna array direto (ex: clientes sem paginacao)
    if (Array.isArray(raw)) {
      allItems.push(...raw)
      break
    }

    // API retorna { items: [...], hasNext: boolean } (padrao TOTVS)
    const items: any[] = raw.items || raw.data || raw.content || []
    allItems.push(...items)

    // Se nao ha mais paginas, para
    if (!raw.hasNext) break

    page++
    if (page > 100) {
      console.warn(`[fetchAllPages] Limite de 100 paginas atingido em ${endpoint}`)
      break
    }
  }

  return allItems
}

// ============================================================
// SYNC PRINCIPAL POR EMPRESA
// ============================================================
async function syncEmpresa(supabase: any, empresa: any) {
  const inicio = Date.now()
  const detalhes: string[] = []
  // Filial padrao "1,2,3,4,5,6" se nao configurada
  const filialId = empresa.winthor_filial || '1,2,3,4,5,6'

  const log = {
    empresa_id: empresa.id,
    status: 'sucesso',
    clientes_novos: 0,
    clientes_atualizados: 0,
    pedidos_novos: 0,
    produtos_novos: 0,
    erro_msg: null as string | null,
    duracao_segundos: 0
  }

  try {
    const baseUrl = empresa.winthor_url.replace(/\/$/, '')
    detalhes.push(`Empresa ${empresa.id} | Filial: ${filialId}`)

    // ── 1. LOGIN ──────────────────────────────────────────────
    detalhes.push('Autenticando no Winthor...')
    const loginRes = await fetchWithTimeout(`${baseUrl}/winthor/autenticacao/v1/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: empresa.winthor_login, senha: empresa.winthor_senha })
    }, 30000)

    if (!loginRes.ok) {
      const body = await loginRes.text()
      throw new Error(`Login falhou HTTP ${loginRes.status}: ${body.substring(0, 300)}`)
    }

    const loginData = await loginRes.json()
    // Campo correto conforme documentacao: accessToken
    const token = loginData.accessToken || loginData.token || loginData.access_token

    if (!token) {
      throw new Error(`Token nao encontrado na resposta do login: ${JSON.stringify(loginData).substring(0, 200)}`)
    }
    detalhes.push('Login OK. Token obtido.')

    const clientesRaw = await fetchAllPages(
      baseUrl,
      '/api/wholesale/v1/customer/list',
      token,
      { withDeliveryAddress: false }
    )
    detalhes.push(`Clientes recebidos da API: ${clientesRaw.length}`)

    if (clientesRaw.length > 0) {
      const BATCH = 1000
      const promessas = []
      for (let i = 0; i < clientesRaw.length; i += BATCH) {
        const lote = clientesRaw.slice(i, i + BATCH).map((c: any) => ({
          id: c.id,                                          // pcclient.codcli
          empresa_id: empresa.id,
          nome: c.name,                                      // pcclient.cliente
          cnpj: c.personIdentificationNumber,               // pcclient.cgcent
          cidade: c.businessCity,                            // pccidade.nomecidade
          estado: c.businessState,                           // pcclient.estent
          vendedor_id: String(c.sellerId || ''),             // pcclient.codusur1
          telefone: c.corporatePhone || c.phone || c.deliveryPhone,
          email: c.email,                                    // pcclient.email
          ativo: c.active !== false,                         // boolean (0 = inativo)
          ultima_compra: null,
          dias_sem_compra: null,
        })).filter((c: any) => c.id)

        if (lote.length > 0) {
          promessas.push(
            supabase
              .from('clientes')
              .upsert(lote, { onConflict: 'id' })
              .then(({ error }: any) => {
                if (error) {
                  detalhes.push(`ERRO clientes lote ${i}: ${error.message}`)
                } else {
                  log.clientes_novos += lote.length
                }
              })
          )
        }
      }
      await Promise.all(promessas)
      detalhes.push(`Clientes processados. Total inserido/atualizado: ${log.clientes_novos}`)
    }

    // ── 3. PEDIDOS ────────────────────────────────────────────
    const branches = String(filialId).split(',').map(b => b.trim()).filter(Boolean)
    detalhes.push(`Buscando pedidos para as filiais: ${branches.join(', ')} (30 dias)...`)
    
    const promessasPedidos = branches.map(async (branch) => {
      try {
        const res = await fetchAllPages(
          baseUrl,
          '/api/wholesale/v1/orders/list',
          token,
          {
            branchId: branch,     // OBRIGATORIO conforme doc TOTVS
            daysOfSearch: 30,     // ultimos 30 dias para evitar timeout no Winthor
            order: 'lastChange',
            saleOrigin: 'T'        // T = busca todas as origens de venda (ERP/RCA/Web)
          }
        )
        detalhes.push(`Filial ${branch}: ${res.length} pedidos recebidos`)
        return res
      } catch (err: any) {
        console.error(`Erro ao buscar pedidos filial ${branch}:`, err)
        detalhes.push(`Filial ${branch} ERRO: ${err.message || String(err)}`)
        return []
      }
    })
    
    const arraysPedidos = await Promise.all(promessasPedidos)
    const pedidosRaw = arraysPedidos.flat()
    detalhes.push(`Total de pedidos recebidos da API: ${pedidosRaw.length}`)

    if (pedidosRaw.length > 0) {
      const BATCH = 1000
      const promessas = []
      for (let i = 0; i < pedidosRaw.length; i += BATCH) {
        const lote = pedidosRaw.slice(i, i + BATCH).map((p: any) => ({
          id: p.orderId,                                          // pcpedc.numped
          empresa_id: empresa.id,
          cliente_id: p.customer?.id,                            // pcpedc.codcli (via customer.id)
          cliente_nome: p.customer?.tradeName || p.customerName,
          data: p.createData                                      // CORRETO: createData (nao createDate!)
            ? new Date(p.createData).toISOString().split('T')[0]
            : null,
          status: p.orderStatus,                                  // pcpedc.posicao
          total: parseFloat(String(p.totalValue || 0)),          // pcpedc.vltotal (vem como string "0.0")
          itens: p.listOfOrderItem || [],
          transportadora: String(p.carrierId || ''),
          plano_pagamento: String(p.paymentPlanId || ''),
          origem: p.saleOrigin || 'W'                            // pcpedc.origemped
        })).filter((p: any) => p.id && p.cliente_id)

        if (lote.length > 0) {
          // Deduplica o lote para evitar erro "ON CONFLICT DO UPDATE command cannot affect row a second time"
          const uniqueMap = new Map()
          lote.forEach((item: any) => uniqueMap.set(item.id, item))
          const uniqueLote = Array.from(uniqueMap.values())

          promessas.push(
            supabase
              .from('pedidos')
              .upsert(uniqueLote, { onConflict: 'id' })
              .then(({ error }: any) => {
                if (error) {
                  detalhes.push(`ERRO pedidos lote ${i}: ${error.message}`)
                } else {
                  log.pedidos_novos += uniqueLote.length
                }
              })
          )
        }
      }
      await Promise.all(promessas)
      detalhes.push(`Pedidos processados. Total inserido/atualizado: ${log.pedidos_novos}`)
    }

    // ── 4. PRODUTOS ───────────────────────────────────────────
    detalhes.push('Buscando produtos...')
    const produtosRaw = await fetchAllPages(
      baseUrl,
      '/api/purchases/v1/products/',
      token,
      { callOrigin: 'W' }    // W = filtra produtos marcados para e-commerce
    )
    detalhes.push(`Produtos recebidos da API: ${produtosRaw.length}`)

    if (produtosRaw.length > 0) {
      const BATCH = 1000
      const promessas = []
      for (let i = 0; i < produtosRaw.length; i += BATCH) {
        const lote = produtosRaw.slice(i, i + BATCH).map((p: any) => ({
          id: p.id,                                              // pcprodut.codprod
          empresa_id: empresa.id,
          nome: p.name,                                          // pcprodut.descricao
          descricao: p.descriptionShort || p.description1,      // pcprodut.descricao1
          categoria_id: String(p.categoryId || ''),              // pcprodut.codcategoria
          fornecedor: p.supplierDescription || String(p.supplierId || ''),
          unidade: p.unity || 'UN',                             // pcprodut.unidade
          ativo: p.isActive !== false && p.active !== false      // ambos os campos conforme doc
        })).filter((p: any) => p.id)

        if (lote.length > 0) {
          promessas.push(
            supabase
              .from('produtos')
              .upsert(lote, { onConflict: 'id' })
              .then(({ error }: any) => {
                if (error) {
                  detalhes.push(`ERRO produtos lote ${i}: ${error.message}`)
                } else {
                  log.produtos_novos += lote.length
                }
              })
          )
        }
      }
      await Promise.all(promessas)
      detalhes.push(`Produtos processados. Total inserido/atualizado: ${log.produtos_novos}`)
    }

    // ── 5. ATUALIZAR ULTIMA SYNC ──────────────────────────────
    await supabase
      .from('empresas')
      .update({ ultima_sync: new Date().toISOString() })
      .eq('id', empresa.id)

    detalhes.push('Atualizando estatísticas dos clientes...')
    const { error: errRpc } = await supabase.rpc('atualizar_estatisticas_clientes')
    if (errRpc) {
      detalhes.push(`ERRO ao rodar RPC estatisticas: ${errRpc.message}`)
    } else {
      detalhes.push('Estatísticas atualizadas com sucesso.')
    }

    log.duracao_segundos = Math.floor((Date.now() - inicio) / 1000)
    detalhes.push(`Sync concluida em ${log.duracao_segundos}s`)
    log.erro_msg = detalhes.join(' | ')

  } catch (error) {
    const err = error as any
    log.status = 'erro'
    log.erro_msg = `ERRO FATAL: ${err.message || String(error)} | Steps: ${detalhes.join(' | ')}`
    log.duracao_segundos = Math.floor((Date.now() - inicio) / 1000)
  }

  await supabase.from('log_sync').insert(log)
  return { ...log, detalhes }
}
