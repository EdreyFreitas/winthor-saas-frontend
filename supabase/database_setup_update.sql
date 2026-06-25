-- ============================================================
-- SQL DE ATUALIZACAO - WINTHOR SAAS
-- Execute este script no editor SQL do Supabase
-- ============================================================

CREATE OR REPLACE FUNCTION public.atualizar_estatisticas_clientes()
RETURNS void AS $$
BEGIN
  -- 1. Atualiza quantidade_pedidos, valor_total_compras, ultima_compra, e dias_sem_compra com base nos pedidos
  UPDATE public.clientes c
  SET 
    quantidade_pedidos = COALESCE(p.qtd_pedidos, 0),
    valor_total_compras = COALESCE(p.val_compras, 0),
    ultima_compra = p.max_date,
    dias_sem_compra = CURRENT_DATE - p.max_date
  FROM (
    SELECT 
      cliente_id, 
      COUNT(id) as qtd_pedidos,
      SUM(total) as val_compras,
      MAX(data) as max_date
    FROM public.pedidos
    GROUP BY cliente_id
  ) p
  WHERE c.id = p.cliente_id;

  -- 2. Zera as estatísticas dos clientes que não possuem pedidos
  UPDATE public.clientes c
  SET 
    quantidade_pedidos = 0,
    valor_total_compras = 0,
    ultima_compra = NULL,
    dias_sem_compra = NULL
  WHERE NOT EXISTS (
    SELECT 1 FROM public.pedidos p WHERE p.cliente_id = c.id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
