-- A migração `audit_append_only` criou o papel da aplicação com uma senha fixa,
-- pensada só para o ambiente local. Ela deixa de valer: as Lambdas se conectam
-- por token IAM no RDS Proxy, e a senha que o Proxy usa existe só no Secrets
-- Manager (`<cluster>/database/app`), gravada no banco durante o deploy por
-- `scripts/sincroniza-senha-banco.sh`. Até lá o papel não autentica: falha
-- fechada, e não aberta.
ALTER ROLE customer_service_app PASSWORD NULL;
