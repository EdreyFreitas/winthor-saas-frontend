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

-- ============================================================
-- FIX: CORRECAO DE RECURSAO INFINITA NAS POLICIES RLS
-- ============================================================

-- 1. Remover as políticas antigas problemáticas
DROP POLICY IF EXISTS "perfis_isolamento" ON public.perfis;
DROP POLICY IF EXISTS "empresas_isolamento" ON public.empresas;

-- 2. Criar políticas de SELECT e UPDATE seguras para a tabela empresas
DROP POLICY IF EXISTS "empresas_select" ON public.empresas;
CREATE POLICY "empresas_select" ON public.empresas
  FOR SELECT USING (id = public.minha_empresa_id());

DROP POLICY IF EXISTS "empresas_update" ON public.empresas;
CREATE POLICY "empresas_update" ON public.empresas
  FOR UPDATE USING (id = public.minha_empresa_id());

-- 3. Recriar políticas de perfis de forma segura sem recursão
DROP POLICY IF EXISTS "perfis_select" ON public.perfis;
CREATE POLICY "perfis_select" ON public.perfis
  FOR SELECT USING (
    id = auth.uid() OR 
    empresa_id = public.minha_empresa_id()
  );

DROP POLICY IF EXISTS "perfis_update" ON public.perfis;
CREATE POLICY "perfis_update" ON public.perfis
  FOR UPDATE USING (id = auth.uid());

DROP POLICY IF EXISTS "perfis_insert" ON public.perfis;
CREATE POLICY "perfis_insert" ON public.perfis
  FOR INSERT WITH CHECK (id = auth.uid());
