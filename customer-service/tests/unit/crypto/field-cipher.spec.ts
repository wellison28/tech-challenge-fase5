import { describe, expect, it } from 'vitest';
import { EncryptionContext } from '../../../src/application/ports/crypto';
import { HmacBlindIndex } from '../../../src/infrastructure/crypto/hmac-blind-index';
import { LocalFieldCipher } from '../../../src/infrastructure/crypto/local-field-cipher';

const MASTER_KEY = Buffer.from('chave-mestra-de-teste-com-32-byte').toString('base64');
const CONTEXT: EncryptionContext = {
  customerId: '11111111-1111-4111-8111-111111111111',
  field: 'pii',
};

describe('LocalFieldCipher (mesmo contrato do KmsFieldCipher)', () => {
  const cipher = new LocalFieldCipher(MASTER_KEY);

  it('decifra o que cifrou', async () => {
    const payload = await cipher.encrypt('52998224725', CONTEXT);
    expect(await cipher.decrypt(payload, CONTEXT)).toBe('52998224725');
  });

  it('não guarda o texto claro no payload cifrado', async () => {
    const payload = await cipher.encrypt('52998224725', CONTEXT);
    expect(JSON.stringify(payload)).not.toContain('52998224725');
  });

  it('produz textos cifrados diferentes para o mesmo valor (IV aleatório)', async () => {
    const first = await cipher.encrypt('52998224725', CONTEXT);
    const second = await cipher.encrypt('52998224725', CONTEXT);

    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.iv).not.toBe(second.iv);
  });

  it('recusa decifrar com contexto de outro titular — o AAD amarra o registro', async () => {
    const payload = await cipher.encrypt('52998224725', CONTEXT);

    await expect(
      cipher.decrypt(payload, {
        customerId: '22222222-2222-4222-8222-222222222222',
        field: 'pii',
      }),
    ).rejects.toThrow();
  });

  it('recusa decifrar com outro nome de campo', async () => {
    const payload = await cipher.encrypt('52998224725', CONTEXT);
    await expect(cipher.decrypt(payload, { ...CONTEXT, field: 'outro' })).rejects.toThrow();
  });

  it('detecta adulteração do texto cifrado (tag de autenticação do GCM)', async () => {
    const payload = await cipher.encrypt('52998224725', CONTEXT);
    const bytes = Buffer.from(payload.ciphertext, 'base64');
    bytes[0] = bytes[0]! ^ 0xff;

    await expect(
      cipher.decrypt({ ...payload, ciphertext: bytes.toString('base64') }, CONTEXT),
    ).rejects.toThrow();
  });

  it('detecta adulteração da tag de autenticação', async () => {
    const payload = await cipher.encrypt('52998224725', CONTEXT);
    const tag = Buffer.from(payload.authTag, 'base64');
    tag[0] = tag[0]! ^ 0xff;

    await expect(
      cipher.decrypt({ ...payload, authTag: tag.toString('base64') }, CONTEXT),
    ).rejects.toThrow();
  });

  it('recusa chave mestra curta demais', () => {
    expect(() => new LocalFieldCipher(Buffer.from('curta').toString('base64'))).toThrow();
  });
});

describe('HmacBlindIndex', () => {
  const index = new HmacBlindIndex('pepper-de-teste-com-tamanho-ok');

  it('é determinístico — é o que viabiliza a busca por igualdade', async () => {
    expect(await index.compute('52998224725')).toBe(await index.compute('52998224725'));
  });

  it('normaliza a formatação antes de calcular', async () => {
    expect(await index.compute('529.982.247-25')).toBe(await index.compute('52998224725'));
  });

  it('gera índices distintos para CPFs distintos', async () => {
    expect(await index.compute('52998224725')).not.toBe(await index.compute('11144477735'));
  });

  it('não é reversível para o valor original', async () => {
    expect(await index.compute('52998224725')).not.toContain('52998224725');
  });

  it('muda completamente ao trocar o pepper — habilita rotação', async () => {
    const outro = new HmacBlindIndex('outro-pepper-igualmente-longo', 2);
    expect(await index.compute('52998224725')).not.toBe(await outro.compute('52998224725'));
  });

  it('recusa pepper fraco', () => {
    expect(() => new HmacBlindIndex('curto')).toThrow();
  });
});
