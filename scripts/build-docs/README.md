# Geração do documento dos relatórios

Os três relatórios são escritos e versionados em **Markdown**, em `docs/` — é o
formato em que se revisa e se acompanha alteração. Este script os converte em um
**HTML paginado para impressão**, que é o formato do entregável (PDF).

```bash
pip install markdown
python3 scripts/build-docs/build.py
# abra docs/relatorios.html e imprima em PDF (Ctrl/Cmd + P)
```

## Por que um script, e não HTML escrito à mão

Transcrever o conteúdo manualmente criaria duas fontes da verdade: a primeira
correção feita no Markdown depois da transcrição já deixaria o PDF
desatualizado, sem nenhum sinal disso. Com a conversão em script, o documento
impresso **não pode divergir** dos arquivos versionados.

## Arquivos

| Arquivo | Papel |
|---|---|
| `build.py` | Conversão Markdown → HTML e montagem do documento |
| `template.html` | `<title>`, fontes e todo o CSS, incluindo as regras de impressão |
| `body.html` | Estrutura da página, com marcadores `<!--RAIL-->`, `<!--COMPACT_TOC-->` e `<!--SECTIONS-->` |

## O que o script trata

- **Diagramas Mermaid** saem do caminho do conversor antes da conversão, para
  não serem escapados, e voltam como `<pre class="mermaid">`.
- **Tabelas de definição** (rótulo/valor, sem cabeçalho) perdem o `<thead>`
  vazio e recebem estilo próprio.
- **Links relativos** para arquivos do repositório viram código: como âncoras,
  ficariam mortas no documento impresso.
- **Âncoras** são geradas nos `<h2>` para alimentar o sumário lateral.
- Tabelas, blocos de código e diagramas ganham container com rolagem própria,
  para que o corpo da página nunca role na horizontal.

## Impressão

O CSS de impressão (em `template.html`) define A4 com margens de 18 mm, esconde
a navegação, começa **cada relatório em página nova**, repete o cabeçalho de
tabelas que atravessam páginas e evita quebra dentro de tabelas, diagramas e
blocos de código.
