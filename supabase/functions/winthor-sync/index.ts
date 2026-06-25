// ============================================================
// SUPABASE EDGE FUNCTION: winthor-sync v2
// Sincroniza dados do Winthor para o Supabase
// Melhorias: paginacao, bulk upsert, 365 dias de pedidos, log detalhado
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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
      .select('id, winthor_url, winthor_login, winthor_senha')
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
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})

// ============================================================
// HELPER: busca com paginacao automatica
// ============================================================
async function fetchAllPages(baseUrl: string, endpoint: string, token: string, extraParams = ''): Promise<any[]> {
  const allItems: any[] = []
  let page = 1
  const pageSize = 500

  while (true) {
    const url = `${baseUrl}${endpoint}?pageSize=${pageSize}&page=${page}${extraParams}`
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    })

    if (!res.ok) {
      console.error(`Erro na pagina ${page}: ${res.status} ${url}`)
      break
    }

    const raw = await res.json()
    // Suporte a diferentes formatos de resposta da API Winthor
    const items = Array.isArray(raw) ? raw
      : (raw.items || raw.data || raw.content || raw.result || raw.customers || raw.orders || raw.products || [])

    if (items.length === 0) break
    allItems.push(...items)

    // Se retornou menos que pageSize, acabou
    if (items.length < pageSize) break
    page++

    // Segurança: max 20 paginas (10.000 registros)
    if (page > 20) break
  }

  return allItems
}

// ============================================================
// SYNC PRINCIPAL
// ============================================================
async function syncEmpresa(supabase: any, empresa: any) {
  const inicio = Date.now()
  const detalhes: string[] = []

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
    detalhes.push(`Iniciando sync para empresa ${empresa.id}`)

    // ── 1. LOGIN NO WINTHOR ──────────────────────────────────
    detalhes.push('Autenticando no Winthor...')
    const loginRes = await fetch(`${baseUrl}/winthor/autenticacao/v1/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: empresa.winthor_login, senha: empresa.winthor_senha })
    })

    if (!loginRes.ok) {
      const body = await loginRes.text()
      throw new Error(`Login Winthor falhou: HTTP ${loginRes.status} - ${body.substring(0, 200)}`)
    }

    const loginData = await loginRes.json()
    const token = loginData.accessToken || loginData.token || loginData.access_token

    if (!token) {
      throw new Error(`Token nao encontrado na resposta: ${JSON.stringify(loginData).substring(0, 200)}`)
    }
    detalhes.push(`Login OK. Token obtido.`)

    // ── 2. CLIENTES (com paginacao) ──────────────────────────
    detalhes.push('Buscando clientes (paginado)...')
    const clientesRaw = await fetchAllPages(
      baseUrl,
      '/api/wholesale/v1/customer/list',
      token,
      '&withDeliveryAddress=false'
    )
    detalhes.push(`${clientesRaw.length} clientes encontrados na API`)

    if (clientesRaw.length > 0) {
      // Processa em lotes de 200 para o upsert
      const BATCH = 200
      for (let i = 0; i < clientesRaw.length; i += BATCH) {
        const lote = clientesRaw.slice(i, i + BATCH).map(c => ({
          id: c.customerId || c.id,
          empresa_id: empresa.id,
          nome: c.name || c.tradeName || c.companyName,
          cnpj: c.personIdentificationNumber || c.cnpj || c.document,
          cidade: c.businessCity || c.city,
          estado: c.businessState || c.state,
          vendedor_id: String(c.sellerId || c.salespersonId || ''),
          telefone: c.phone || c.corporatePhone || c.cellPhone,
          email: c.email,
          ativo: c.active !== false && c.status !== 'I',
          ultima_compra: c.lastOrderDate
            ? new Date(c.lastOrderDate).toISOString().split('T')[0]
            : null,
          dias_sem_compra: c.lastOrderDate
            ? Math.floor((Date.now() - new Date(c.lastOrderDate).getTime()) / 86400000)
            : null,
          quantidade_pedidos: c.totalOrders || 0,
          valor_total_compras: c.totalPurchaseValue || 0
        })).filter(c => c.id)

        if (lote.length > 0) {
          const { error, count } = await supabase
            .from('clientes')
            .upsert(lote, { onConflict: 'id,empresa_id', ignoreDuplicates: false })
            .select('id', { count: 'exact', head: true })

          if (error) {
            detalhes.push(`ERRO upsert clientes lote ${i}-${i+BATCH}: ${error.message}`)
          } else {
            log.clientes_novos += lote.length
          }
        }
      }
      detalhes.push(`Clientes salvos: ${log.clientes_novos}`)
    }

    // ── 3. PEDIDOS (365 dias, com paginacao) ─────────────────
    detalhes.push('Buscando pedidos (365 dias, paginado)...')
    const pedidosRaw = await fetchAllPages(
      baseUrl,
      '/api/wholesale/v1/orders/list',
      token,
      '&daysOfSearch=365'
    )
    detalhes.push(`${pedidosRaw.length} pedidos encontrados na API`)

    if (pedidosRaw.length > 0) {
      const BATCH = 200
      for (let i = 0; i < pedidosRaw.length; i += BATCH) {
        const lote = pedidosRaw.slice(i, i + BATCH).map(p => ({
          id: p.orderId || p.id || p.orderCode || p.numeroPedido,
          empresa_id: empresa.id,
          cliente_id: p.customerId || p.customer?.id || p.customer?.customerId,
          cliente_nome: p.customerName || p.customer?.tradeName || p.customer?.name || p.nomeCliente,
          data: (p.orderDate || p.createDate || p.createdAt || p.dataPedido)
            ? new Date(p.orderDate || p.createDate || p.createdAt || p.dataPedido).toISOString().split('T')[0]
            : null,
          status: p.orderStatus || p.status || p.situacao,
          total: parseFloat(p.totalValue || p.total || p.valorTotal || 0),
          itens: p.listOfOrderItem || p.items || p.itens || [],
          transportadora: String(p.carrierId || p.transportadora || ''),
          plano_pagamento: String(p.paymentPlanId || p.planoPagamento || ''),
          origem: p.saleOrigin || p.origem || 'winthor'
        })).filter(p => p.id && p.cliente_id)

        if (lote.length > 0) {
          const { error } = await supabase
            .from('pedidos')
            .upsert(lote, { onConflict: 'id,empresa_id', ignoreDuplicates: false })

          if (error) {
            detalhes.push(`ERRO upsert pedidos lote ${i}-${i+BATCH}: ${error.message}`)
          } else {
            log.pedidos_novos += lote.length
          }
        }
      }
      detalhes.push(`Pedidos salvos: ${log.pedidos_novos}`)
    }

    // ── 4. PRODUTOS (com paginacao) ──────────────────────────
    detalhes.push('Buscando produtos (paginado)...')
    const produtosRaw = await fetchAllPages(
      baseUrl,
      '/api/purchases/v1/products/',
      token
    )
    detalhes.push(`${produtosRaw.length} produtos encontrados na API`)

    if (produtosRaw.length > 0) {
      const BATCH = 200
      for (let i = 0; i < produtosRaw.length; i += BATCH) {
        const lote = produtosRaw.slice(i, i + BATCH).map(p => ({
          id: p.productId || p.id || p.codigoProduto,
          empresa_id: empresa.id,
          nome: p.name || p.descricao || p.productName,
          descricao: p.descriptionShort || p.description,
          categoria_id: String(p.categoryId || p.categoria || ''),
          categoria_nome: p.categoryName || p.nomeCategoria || '',
          fornecedor: p.supplierDescription || String(p.supplierId || ''),
          unidade: p.unity || p.unidade || 'UN',
          ativo: p.isActive !== false && p.active !== false,
          quantidade_vendida: parseFloat(p.quantitySold || p.quantidadeVendida || 0)
        })).filter(p => p.id)

        if (lote.length > 0) {
          const { error } = await supabase
            .from('produtos')
            .upsert(lote, { onConflict: 'id,empresa_id', ignoreDuplicates: false })

          if (error) {
            detalhes.push(`ERRO upsert produtos lote ${i}-${i+BATCH}: ${error.message}`)
          } else {
            log.produtos_novos += lote.length
          }
        }
      }
      detalhes.push(`Produtos salvos: ${log.produtos_novos}`)
    }

    // ── 5. ATUALIZAR ULTIMA SYNC ─────────────────────────────
    await supabase
      .from('empresas')
      .update({ ultima_sync: new Date().toISOString() })
      .eq('id', empresa.id)

    log.duracao_segundos = Math.floor((Date.now() - inicio) / 1000)
    log.erro_msg = detalhes.join(' | ')
    detalhes.push(`Sync concluida em ${log.duracao_segundos}s`)

  } catch (error) {
    log.status = 'erro'
    log.erro_msg = `ERRO: ${error.message} | Detalhes: ${detalhes.join(' | ')}`
    log.duracao_segundos = Math.floor((Date.now() - inicio) / 1000)
  }

  await supabase.from('log_sync').insert(log)
  return { ...log, detalhes }
}
