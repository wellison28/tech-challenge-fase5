/**
 * Quem está acessando, e para quê.
 *
 * Viaja em todo caso de uso que toca dado pessoal. A `purpose` é obrigatória
 * porque o princípio da finalidade (LGPD art. 6º, I) não é verificável depois
 * do fato: ou a finalidade é declarada no momento do acesso e registrada, ou
 * não há como auditá-la.
 */
export interface AccessContext {
  actorId: string;
  actorType: 'USER' | 'SERVICE';
  actorRoles: string[];
  purpose: string;
  correlationId: string;
  sourceIp?: string | null;
  userAgent?: string | null;
}
