import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { Container } from '../../container';
import {
  TokenVerifier,
  authenticate,
  authorize,
  authorizeSelfOrRoles,
  requirePurpose,
  toAccessContext,
} from '../middlewares/authenticate';
import {
  anonymizeResponseSchema,
  billingProfileResponseSchema,
  consentBodySchema,
  consentParamsSchema,
  customerIdParamsSchema,
  documentationDossierResponseSchema,
  eligibilityResponseSchema,
  errorResponseSchema,
  maskedCustomerResponseSchema,
  personalDataExportResponseSchema,
  registerCustomerBodySchema,
  updateCustomerBodySchema,
} from '../schemas/customer-schemas';

export const ROLE_ADMIN = 'admin';
/** Atendimento: vê cadastro mascarado, nunca dado em claro. */
export const ROLE_SUPPORT = 'support';
export const SCOPE_ELIGIBILITY = 'revenda/customers.eligibility';
export const SCOPE_BILLING = 'revenda/customers.billing';
export const SCOPE_DOCUMENTATION = 'revenda/customers.documentation';

export async function customerRoutes(
  app: FastifyInstance,
  container: Container,
  verify: TokenVerifier,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const auth = authenticate(verify);
  const selfOrStaff = authorizeSelfOrRoles([ROLE_ADMIN, ROLE_SUPPORT]);
  const selfOrAdmin = authorizeSelfOrRoles([ROLE_ADMIN]);
  const adminOnly = authorize({ roles: [ROLE_ADMIN] });

  const errors = {
    400: errorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    422: errorResponseSchema,
  };

  // ---------------------------------------------------------------------------
  // Cadastro de compradores
  // ---------------------------------------------------------------------------

  typed.post(
    '/customers',
    {
      // Autocadastro público. O limite de taxa é bem mais apertado aqui do que
      // nas demais rotas: é o endpoint que um atacante usaria para descobrir
      // quais CPFs já estão cadastrados a partir do erro de duplicidade.
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      onRequest: [requirePurpose(['SELF_REGISTRATION', 'IN_STORE_REGISTRATION'])],
      schema: {
        tags: ['Cadastro'],
        summary: 'Cadastra um comprador',
        description:
          'Requer o cabeçalho X-Data-Purpose. A resposta é sempre mascarada, ' +
          'mesmo para quem enviou os dados.',
        body: registerCustomerBodySchema,
        response: { 201: maskedCustomerResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const customer = await container.useCases.registerCustomer.execute({
        ...request.body,
        context: toAccessContext(request),
      });
      return reply.status(201).header('Location', `/customers/${customer.id}`).send(customer);
    },
  );

  typed.get(
    '/customers/:id',
    {
      onRequest: [auth, selfOrStaff, requirePurpose()],
      schema: {
        tags: ['Cadastro'],
        summary: 'Consulta o cadastro (dados mascarados)',
        security: [{ bearerAuth: [] }],
        params: customerIdParamsSchema,
        response: { 200: maskedCustomerResponseSchema, ...errors },
      },
    },
    async (request) =>
      container.useCases.getCustomer.execute(request.params.id, toAccessContext(request)),
  );

  typed.put(
    '/customers/:id',
    {
      onRequest: [auth, selfOrAdmin, requirePurpose()],
      schema: {
        tags: ['Cadastro'],
        summary: 'Atualiza dados cadastrais (o CPF não é editável)',
        security: [{ bearerAuth: [] }],
        params: customerIdParamsSchema,
        body: updateCustomerBodySchema,
        response: { 200: maskedCustomerResponseSchema, ...errors },
      },
    },
    async (request) =>
      container.useCases.updateCustomer.execute({
        ...request.body,
        customerId: request.params.id,
        context: toAccessContext(request),
      }),
  );

  typed.post(
    '/customers/:id/activation',
    {
      onRequest: [auth, adminOnly, requirePurpose()],
      schema: {
        tags: ['Cadastro'],
        summary: 'Ativa o cadastro após a verificação de e-mail',
        security: [{ bearerAuth: [] }],
        params: customerIdParamsSchema,
        response: { 200: maskedCustomerResponseSchema, ...errors },
      },
    },
    async (request) =>
      container.useCases.changeStatus.activate(request.params.id, toAccessContext(request)),
  );

  typed.post(
    '/customers/:id/block',
    {
      onRequest: [auth, adminOnly, requirePurpose()],
      schema: {
        tags: ['Cadastro'],
        summary: 'Bloqueia o cadastro',
        security: [{ bearerAuth: [] }],
        params: customerIdParamsSchema,
        response: { 200: maskedCustomerResponseSchema, ...errors },
      },
    },
    async (request) =>
      container.useCases.changeStatus.block(request.params.id, toAccessContext(request)),
  );

  // ---------------------------------------------------------------------------
  // Direitos do titular (LGPD art. 18)
  // ---------------------------------------------------------------------------

  typed.post(
    '/customers/:id/consents',
    {
      onRequest: [auth, selfOrAdmin, requirePurpose()],
      schema: {
        tags: ['LGPD'],
        summary: 'Registra consentimento para uma finalidade',
        security: [{ bearerAuth: [] }],
        params: customerIdParamsSchema,
        body: consentBodySchema,
        response: { 200: maskedCustomerResponseSchema, ...errors },
      },
    },
    async (request) =>
      container.useCases.manageConsent.grant({
        customerId: request.params.id,
        purpose: request.body.purpose,
        source: request.body.source,
        context: toAccessContext(request),
      }),
  );

  typed.delete(
    '/customers/:id/consents/:purpose',
    {
      onRequest: [auth, selfOrAdmin, requirePurpose()],
      schema: {
        tags: ['LGPD'],
        summary: 'Revoga consentimento (art. 8º, §5º — tão simples quanto concedê-lo)',
        security: [{ bearerAuth: [] }],
        params: consentParamsSchema,
        response: { 200: maskedCustomerResponseSchema, ...errors },
      },
    },
    async (request) =>
      container.useCases.manageConsent.revoke({
        customerId: request.params.id,
        purpose: request.params.purpose,
        context: toAccessContext(request),
      }),
  );

  typed.get(
    '/customers/:id/personal-data-export',
    {
      onRequest: [auth, selfOrAdmin, requirePurpose(['DATA_SUBJECT_REQUEST'])],
      schema: {
        tags: ['LGPD'],
        summary: 'Portabilidade: exporta todos os dados do titular (art. 18, V)',
        description: 'Inclui a trilha de acessos ao próprio cadastro.',
        security: [{ bearerAuth: [] }],
        params: customerIdParamsSchema,
        response: { 200: personalDataExportResponseSchema, ...errors },
      },
    },
    async (request) =>
      container.useCases.exportPersonalData.dataSubjectExport(
        request.params.id,
        toAccessContext(request),
      ),
  );

  typed.delete(
    '/customers/:id',
    {
      onRequest: [auth, selfOrAdmin, requirePurpose(['DATA_SUBJECT_REQUEST'])],
      schema: {
        tags: ['LGPD'],
        summary: 'Eliminação: anonimiza o cadastro (art. 18, VI)',
        description:
          'A linha é mantida sem nenhum dado pessoal, porque as vendas concluídas ' +
          'estão sob guarda fiscal obrigatória. A operação é irreversível.',
        security: [{ bearerAuth: [] }],
        params: customerIdParamsSchema,
        response: { 200: anonymizeResponseSchema, ...errors },
      },
    },
    async (request) =>
      container.useCases.anonymizeCustomer.execute(request.params.id, toAccessContext(request)),
  );

  // ---------------------------------------------------------------------------
  // Integração com a SAGA — tokens máquina-a-máquina, tráfego interno à VPC
  // ---------------------------------------------------------------------------

  typed.get(
    '/internal/customers/:id/eligibility',
    {
      onRequest: [
        auth,
        authorize({ scopes: [SCOPE_ELIGIBILITY] }),
        requirePurpose(['PURCHASE_SAGA']),
      ],
      schema: {
        tags: ['SAGA'],
        summary: 'Verifica se o comprador pode adquirir um veículo',
        description: 'Não devolve nenhum dado pessoal — apenas o veredito e os motivos.',
        security: [{ bearerAuth: [] }],
        params: customerIdParamsSchema,
        response: { 200: eligibilityResponseSchema, ...errors },
      },
    },
    async (request) =>
      container.useCases.checkEligibility.execute(request.params.id, toAccessContext(request)),
  );

  typed.get(
    '/internal/customers/:id/billing-profile',
    {
      onRequest: [auth, authorize({ scopes: [SCOPE_BILLING] }), requirePurpose(['PAYMENT_CODE_ISSUANCE'])],
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        tags: ['SAGA'],
        summary: 'Dados do pagador para emissão do código de pagamento',
        description:
          'Um dos dois únicos caminhos que devolvem dado pessoal em claro. ' +
          'Exige escopo próprio e gera registro de auditoria.',
        security: [{ bearerAuth: [] }],
        params: customerIdParamsSchema,
        response: { 200: billingProfileResponseSchema, ...errors },
      },
    },
    async (request) =>
      container.useCases.exportPersonalData.billingProfile(
        request.params.id,
        toAccessContext(request),
      ),
  );

  typed.get(
    '/internal/customers/:id/documentation-dossier',
    {
      onRequest: [
        auth,
        authorize({ scopes: [SCOPE_DOCUMENTATION] }),
        requirePurpose(['VEHICLE_DOCUMENT_ISSUANCE']),
      ],
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        tags: ['SAGA'],
        summary: 'Dados para emissão da documentação do veículo na retirada',
        security: [{ bearerAuth: [] }],
        params: customerIdParamsSchema,
        response: { 200: documentationDossierResponseSchema, ...errors },
      },
    },
    async (request) =>
      container.useCases.exportPersonalData.documentationDossier(
        request.params.id,
        toAccessContext(request),
      ),
  );
}
