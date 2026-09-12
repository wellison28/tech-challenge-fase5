import { z } from 'zod';
import { ConsentPurpose } from '../../../domain/entities/consent';
import { Cpf } from '../../../domain/value-objects/cpf';

const ufSchema = z.enum([
  'AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB',
  'PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO',
]);

export const addressSchema = z.object({
  zipCode: z.string().min(8).max(9),
  street: z.string().min(1).max(150),
  number: z.string().min(1).max(20),
  complement: z.string().max(100).optional().nullable(),
  district: z.string().min(1).max(100),
  city: z.string().min(1).max(100),
  state: ufSchema,
});

export const identityDocumentSchema = z.object({
  type: z.enum(['RG', 'CNH']),
  number: z.string().min(5).max(20),
  issuer: z.string().min(2).max(20),
});

export const registerCustomerBodySchema = z.object({
  /**
   * Só no cadastro na loja: `sub` da conta do comprador no Cognito. No
   * autocadastro o id vem do próprio token.
   */
  customerId: z.string().uuid().optional(),
  fullName: z.string().min(3).max(150),
  // A validação dos dígitos verificadores acontece aqui, na borda: rejeitar um
  // CPF impossível antes de chegar ao domínio evita gravar lixo e reduz a
  // superfície de enumeração.
  cpf: z.string().refine(Cpf.isValid, 'CPF inválido'),
  birthDate: z.string().date('Data de nascimento deve estar no formato YYYY-MM-DD'),
  email: z.string().email().max(254),
  phone: z.string().min(10).max(20),
  address: addressSchema,
  identityDocument: identityDocumentSchema,
  consentSource: z.enum(['WEB_FORM', 'MOBILE_APP', 'IN_STORE', 'MIGRATION']).default('WEB_FORM'),
  optionalConsents: z.array(z.nativeEnum(ConsentPurpose)).optional(),
});

export const updateCustomerBodySchema = z
  .object({
    fullName: z.string().min(3).max(150).optional(),
    email: z.string().email().max(254).optional(),
    phone: z.string().min(10).max(20).optional(),
    address: addressSchema.optional(),
    identityDocument: identityDocumentSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Informe ao menos um campo para atualizar',
  });

export const customerIdParamsSchema = z.object({
  id: z.string().uuid('Identificador de cliente inválido'),
});

export const consentBodySchema = z.object({
  purpose: z.nativeEnum(ConsentPurpose),
  source: z.enum(['WEB_FORM', 'MOBILE_APP', 'IN_STORE', 'MIGRATION']).default('WEB_FORM'),
});

export const consentParamsSchema = customerIdParamsSchema.extend({
  purpose: z.nativeEnum(ConsentPurpose),
});

const consentResponseSchema = z.object({
  purpose: z.string(),
  granted: z.boolean(),
  policyVersion: z.string(),
  grantedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  source: z.string(),
});

export const maskedCustomerResponseSchema = z.object({
  id: z.string().uuid(),
  fullName: z.string().nullable(),
  cpf: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  location: z.object({ city: z.string(), state: z.string() }).nullable(),
  identityDocument: z
    .object({ type: z.string(), number: z.string(), issuer: z.string() })
    .nullable(),
  status: z.string(),
  consents: z.array(consentResponseSchema),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  anonymizedAt: z.string().nullable(),
});

export const eligibilityResponseSchema = z.object({
  customerId: z.string().uuid(),
  eligible: z.boolean(),
  reasons: z.array(z.string()),
});

export const billingProfileResponseSchema = z.object({
  customerId: z.string().uuid(),
  fullName: z.string(),
  cpf: z.string(),
  email: z.string(),
  phone: z.string(),
});

export const documentationDossierResponseSchema = z.object({
  customerId: z.string().uuid(),
  fullName: z.string(),
  cpf: z.string(),
  birthDate: z.string(),
  identityDocument: z.object({ type: z.string(), number: z.string(), issuer: z.string() }),
  address: z.object({
    zipCode: z.string(),
    street: z.string(),
    number: z.string(),
    complement: z.string().nullable(),
    district: z.string(),
    city: z.string(),
    state: z.string(),
  }),
});

export const anonymizeResponseSchema = z.object({
  customerId: z.string().uuid(),
  anonymizedAt: z.string(),
  alreadyAnonymized: z.boolean(),
});

export const personalDataExportResponseSchema = z.object({
  personalData: z.object({
    id: z.string().uuid(),
    fullName: z.string().nullable(),
    cpf: z.string().nullable(),
    cpfFormatted: z.string().nullable(),
    birthDate: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    address: z
      .object({
        zipCode: z.string(),
        street: z.string(),
        number: z.string(),
        complement: z.string().nullable(),
        district: z.string(),
        city: z.string(),
        state: z.string(),
      })
      .nullable(),
    identityDocument: z
      .object({ type: z.string(), number: z.string(), issuer: z.string() })
      .nullable(),
    status: z.string(),
  }),
  accessLog: z.array(
    z.object({
      action: z.string(),
      purpose: z.string(),
      actorType: z.string(),
      outcome: z.string(),
      fieldsAccessed: z.array(z.string()),
      correlationId: z.string(),
      occurredAt: z.string(),
    }),
  ),
});

export const errorResponseSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
  correlationId: z.string(),
});
