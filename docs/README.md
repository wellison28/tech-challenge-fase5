# Documentação

Os três relatórios exigidos pelo enunciado, em Markdown versionado.

| Arquivo | Entregável |
|---|---|
| [`01-arquitetura.md`](01-arquitetura.md) | Desenho da arquitetura, justificativa dos serviços de nuvem e dos serviços de segurança |
| [`02-relatorio-seguranca.md`](02-relatorio-seguranca.md) | Dados armazenados, dados sensíveis, políticas de acesso, políticas de operação, riscos e mitigações |
| [`03-relatorio-saga.md`](03-relatorio-saga.md) | Tipo de orquestração SAGA e justificativa |

## Gerando o PDF

`relatorios.html` reúne os três em um documento único, com CSS de impressão
(A4, cada relatório começando em página nova). É **gerado**, não editado à mão:

```bash
pip install markdown
python3 ../scripts/build-docs/build.py
```

Depois, abra `relatorios.html` no navegador e imprima em PDF (Ctrl/Cmd + P).

Para alterar o conteúdo, edite os arquivos `.md` e rode o script de novo — assim
o PDF nunca diverge do que está versionado.
