import { request } from 'undici';

/**
 * Token máquina-a-máquina (OAuth2 *client credentials* do Cognito).
 *
 * A chamada entre serviços não usa o token do usuário final: ela usa uma
 * identidade própria do sales-service, com escopos restritos ao que os passos
 * da SAGA precisam. Repassar o token do comprador daria ao serviço de vendas a
 * autorização do usuário — e qualquer falha ali viraria escalonamento de
 * privilégio.
 *
 * O token é cacheado até pouco antes de expirar; renovar a cada chamada
 * multiplicaria a latência e o custo de cada passo.
 */
const RENEWAL_MARGIN_SECONDS = 60;

export class M2mTokenProvider {
  private token: string | null = null;
  private expiresAtMs = 0;

  constructor(
    private readonly config: {
      tokenUrl: string;
      clientId: string;
      clientSecret: string;
      scopes: string[];
    },
  ) {}

  async getToken(): Promise<string> {
    if (this.token && Date.now() < this.expiresAtMs) {
      return this.token;
    }

    const credentials = Buffer.from(
      `${this.config.clientId}:${this.config.clientSecret}`,
    ).toString('base64');

    const response = await request(this.config.tokenUrl, {
      method: 'POST',
      headers: {
        authorization: `Basic ${credentials}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: this.config.scopes.join(' '),
      }).toString(),
    });

    if (response.statusCode !== 200) {
      throw new Error(
        `Falha ao obter token máquina-a-máquina: HTTP ${response.statusCode}`,
      );
    }

    const payload = (await response.body.json()) as { access_token: string; expires_in: number };
    this.token = payload.access_token;
    this.expiresAtMs = Date.now() + (payload.expires_in - RENEWAL_MARGIN_SECONDS) * 1000;
    return this.token;
  }
}

/**
 * Emissor local de tokens para desenvolvimento (`AUTH_MODE=dev`).
 * Assina HS256 com o mesmo segredo que os serviços parceiros validam.
 */
export class DevTokenProvider {
  constructor(
    private readonly secret: string,
    private readonly scopes: string[],
  ) {}

  async getToken(): Promise<string> {
    const { SignJWT } = await import('jose');
    return new SignJWT({ scope: this.scopes.join(' ') })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('sales-service')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(this.secret));
  }
}
