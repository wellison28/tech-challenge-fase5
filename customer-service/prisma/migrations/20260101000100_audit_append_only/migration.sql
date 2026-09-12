-- ============================================================================
-- Trilha de auditoria imutável.
--
-- A aplicação roda com um papel próprio (`customer_service_app`) que pode
-- INSERIR e LER a trilha, mas não pode alterá-la nem apagá-la. Assim, uma
-- credencial de aplicação comprometida — por SQL injection ou por vazamento do
-- segredo do banco — não permite ao atacante remover o rastro dos acessos que
-- fez. Apagar a trilha exigiria as credenciais do dono do schema, que só o
-- pipeline de migração possui.
--
-- Um gatilho reforça a regra no próprio banco: mesmo um papel com UPDATE ou
-- DELETE concedido por engano é bloqueado.
-- ============================================================================

-- Bloqueio no nível do banco, independente de GRANT.
CREATE OR REPLACE FUNCTION reject_audit_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'data_access_logs é append-only: % não é permitido nesta tabela', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER data_access_logs_no_update
  BEFORE UPDATE ON "data_access_logs"
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

CREATE TRIGGER data_access_logs_no_delete
  BEFORE DELETE ON "data_access_logs"
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

-- Papel da aplicação com o mínimo necessário.
-- A senha real é injetada pelo pipeline a partir do Secrets Manager; o valor
-- abaixo só existe para o ambiente local.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'customer_service_app') THEN
    CREATE ROLE customer_service_app LOGIN PASSWORD 'trocar-no-deploy';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO customer_service_app;

-- Dados operacionais: leitura e escrita completas.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "customers", "customer_consents", "outbox_events"
  TO customer_service_app;

-- Auditoria: somente acrescentar e consultar.
GRANT SELECT, INSERT ON "data_access_logs" TO customer_service_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "data_access_logs" FROM customer_service_app;

-- Nenhuma permissão de DDL: a aplicação não altera o schema em tempo de execução.
REVOKE CREATE ON SCHEMA public FROM customer_service_app;
