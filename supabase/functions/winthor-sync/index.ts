// ============================================================
// SUPABASE EDGE FUNCTION: winthor-sync
// Sincroniza dados do Winthor para o Supabase
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

async function syncEmpresa(supabase, empresa) {
  const inicio = Date.now()
  const log = {
    empresa_id: empresa.id,
    status: 'sucesso',
    clientes_novos: 0,
    clientes_atualizados: 0,
    pedidos_novos: 0,
    produtos_novos: 0,
    erro_msg: null,
    duracao_segundos: 0
  }

  try {
    const baseUrl = empresa.winthor_url.replace(/\/$/, '')

    // LOGIN NO WINTHOR
    const loginRes = await fetch(`${baseUrl}/winthor/autenticacao/v1/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        login: empresa.winthor_login,
        senha: empresa.winthor_senha
      })
    })

    if (!loginRes.ok) {
      throw new Error(`Login Winthor falhou: ${loginRes.status}`)
    }

    const loginData = await loginRes.json()
    const token = loginData.accessToken

    // SINCRONIZAR CLIENTES
    const clientesRes = await fetch(
      `${baseUrl}/api/wholesale/v1/customer/list?withDeliveryAddress=false&pageSize=1000`,
      { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
    )

    if (clientesRes.ok) {
      const clientesData = await clientesRes.json()
      const clientesRaw = Array.isArray(clientesData) ? clientesData : (clientesData.items || clientesData.customers || [])

      for (const c of clientesRaw) {
        const cliente = {
          id: c.customerId || c.id,
          empresa_id: empresa.id,
          nome: c.name,
          cnpj: c.personIdentificationNumber,
          cidade: c.businessCity,
          estado: c.businessState,
          vendedor_id: c.sellerId,
          telefone: c.phone || c.corporatePhone,
          email: c.email,
          ativo: c.active !== false,
          ultima_compra: c.lastOrderDate ? new Date(c.lastOrderDate).toISOString().split('T')[0] : null,
          dias_sem_compra: c.lastOrderDate ? Math.floor((Date.now() - new Date(c.lastOrderDate).getTime()) / 86400000) : null
        }

        const { data: existente } = await supabase
          .from('clientes')
          .select('id')
          .eq('id', cliente.id)
          .eq('empresa_id', empresa.id)
          .single()

        if (existente) {
          await supabase.from('clientes').update(cliente).eq('id', cliente.id)
          log.clientes_atualizados++
        } else {
          await supabase.from('clientes').insert(cliente)
          log.clientes_novos++
        }
      }
    }

    // SINCRONIZAR PEDIDOS (ultimos 30 dias)
    const pedidosRes = await fetch(
      `${baseUrl}/api/wholesale/v1/orders/list?daysOfSearch=30&pageSize=1000`,
      { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
    )

    if (pedidosRes.ok) {
      const pedidosData = await pedidosRes.json()
      const pedidosRaw = Array.isArray(pedidosData) ? pedidosData : (pedidosData.items || pedidosData.orders || [])

      for (const p of pedidosRaw) {
        const pedido = {
          id: p.orderId,
          empresa_id: empresa.id,
          cliente_id: p.customer?.id,
          cliente_nome: p.customer?.tradeName,
          data: p.createData ? new Date(p.createData).toISOString().split('T')[0] : null,
          status: p.orderStatus,
          total: p.totalValue,
          itens: p.listOfOrderItem || [],
          transportadora: p.carrierId,
          plano_pagamento: p.paymentPlanId,
          origem: p.saleOrigin
        }

        const { data: existente } = await supabase
          .from('pedidos')
          .select('id')
          .eq('id', pedido.id)
          .eq('empresa_id', empresa.id)
          .single()

        if (!existente) {
          await supabase.from('pedidos').insert(pedido)
          log.pedidos_novos++
        }
      }
    }

    // SINCRONIZAR PRODUTOS
    const produtosRes = await fetch(
      `${baseUrl}/api/purchases/v1/products/?pageSize=1000`,
      { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
    )

    if (produtosRes.ok) {
      const produtosData = await produtosRes.json()
      const produtosRaw = Array.isArray(produtosData) ? produtosData : (produtosData.items || [])

      for (const p of produtosRaw) {
        const produto = {
          id: p.id,
          empresa_id: empresa.id,
          nome: p.name,
          descricao: p.descriptionShort,
          categoria_id: p.categoryId,
          fornecedor: p.supplierDescription || p.supplierId,
          unidade: p.unity,
          ativo: p.isActive !== false
        }

        const { data: existente } = await supabase
          .from('produtos')
          .select('id')
          .eq('id', produto.id)
          .eq('empresa_id', empresa.id)
          .single()

        if (!existente) {
          await supabase.from('produtos').insert(produto)
          log.produtos_novos++
        }
      }
    }

    // ATUALIZAR ULTIMA SYNC
    await supabase
      .from('empresas')
      .update({ ultima_sync: new Date().toISOString() })
      .eq('id', empresa.id)

    log.duracao_segundos = Math.floor((Date.now() - inicio) / 1000)

  } catch (error) {
    log.status = 'erro'
    log.erro_msg = error.message
    log.duracao_segundos = Math.floor((Date.now() - inicio) / 1000)
  }

  await supabase.from('log_sync').insert(log)
  return log
}
