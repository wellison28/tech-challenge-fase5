-- Papel da aplicação, com o mínimo necessário.
--
-- As Lambdas se conectam como este usuário, autenticadas no RDS Proxy por token
-- IAM. A senha existe só no Secrets Manager (`<cluster>/database/app`), usada
-- pelo Proxy para abrir a conexão real; é gravada no banco durante o deploy por
-- `scripts/sincroniza-senha-banco.sh` e nunca aparece no repositório. Até lá o
-- papel não autentica: falha fechada, e não aberta.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sales_service_app') THEN
    CREATE ROLE sales_service_app LOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO sales_service_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "orders", "outbox_events", "processed_webhooks" TO sales_service_app;

-- Nenhuma permissão de DDL: a aplicação não altera o schema em tempo de execução.
REVOKE CREATE ON SCHEMA public FROM sales_service_app;
