#!/usr/bin/env python3
"""
Gera o documento único dos três relatórios a partir dos arquivos em `docs/`.

Os relatórios são escritos e versionados em Markdown — é o formato em que se
revisa e se acompanha alteração. Este script os converte em um HTML paginado
para impressão, que é o formato do entregável (PDF).

Manter a conversão em script, e não transcrever o conteúdo à mão, garante que o
PDF nunca divirja dos arquivos versionados.

Uso:
    pip install markdown
    python3 scripts/build-docs/build.py
    # abra docs/relatorios.html e imprima em PDF (Ctrl/Cmd + P)
"""
import html
import json
import pathlib
import re
import sys

try:
    import markdown
except ImportError:
    sys.exit("Dependência ausente. Instale com: pip install markdown")

RAIZ = pathlib.Path(__file__).resolve().parents[2]
DOCS = RAIZ / 'docs'
TEMPLATE = pathlib.Path(__file__).parent / 'template.html'
SAIDA = DOCS / 'relatorios.html'

RELATORIOS = [
    ('01-arquitetura.md',         'arquitetura', 'Desenho da arquitetura'),
    ('02-relatorio-seguranca.md', 'seguranca',   'Relatório de segurança de dados'),
    ('03-relatorio-saga.md',      'saga',        'Relatório de orquestração SAGA'),
]

NUMEROS = ['01', '02', '03']


def converter(caminho: pathlib.Path, slug: str):
    """Converte um relatório em fragmento HTML, preservando os diagramas."""
    bruto = caminho.read_text()
    diagramas: list[str] = []

    # Remove o cabeçalho repetido: o título e o subtítulo já vêm do template.
    linhas, corpo, pulando = bruto.split('\n'), [], True
    for linha in linhas:
        if pulando:
            if (linha.startswith('# ') or not linha.strip()
                    or linha.startswith('Plataforma de revenda')
                    or linha.strip() == '---'):
                continue
            pulando = False
        corpo.append(linha)
    texto = '\n'.join(corpo)

    # Links relativos para arquivos do repositório viram código: como âncoras,
    # ficariam mortas no documento impresso.
    texto = re.sub(r'\[([^\]]+)\]\((?!https?://)([^)]+)\)',
                   lambda m: f'`{m.group(2)}`', texto)

    # Os blocos mermaid saem do caminho do Markdown para não serem escapados.
    def guardar(m):
        diagramas.append(m.group(1))
        return f"\n\nMERMAIDPLACEHOLDER{len(diagramas) - 1}ENDMARKER\n\n"

    texto = re.sub(r'```mermaid\n(.*?)```', guardar, texto, flags=re.S)

    md = markdown.Markdown(
        extensions=['tables', 'fenced_code', 'attr_list', 'sane_lists'])
    saida = md.convert(texto)

    saida = re.sub(
        r'<p>MERMAIDPLACEHOLDER(\d+)ENDMARKER</p>',
        lambda m: ('<div class="figure"><pre class="mermaid">'
                   f'{html.escape(diagramas[int(m.group(1))])}</pre></div>'),
        saida)

    # Tabelas de definição (rótulo/valor) não têm cabeçalho: remove o thead
    # vazio, que só ocuparia espaço com células em branco.
    saida = re.sub(r'<thead>\s*<tr>\s*(?:<th[^>]*>\s*</th>\s*)+</tr>\s*</thead>',
                   '', saida, flags=re.S)
    saida = re.sub(r'<table>(\s*)<tbody>', r'<table class="definition">\1<tbody>', saida)

    # Tabelas, código e diagramas rolam em container próprio, para que o corpo
    # da página nunca role na horizontal.
    saida = saida.replace('<table>', '<div class="table-wrap"><table>')
    saida = saida.replace('<table class="definition">',
                          '<div class="table-wrap"><table class="definition">')
    saida = saida.replace('</table>', '</table></div>')
    saida = saida.replace('<pre><code', '<pre class="code"><code')

    # Âncoras nos H2, para o sumário lateral.
    subsecoes = []
    contador = [0]

    def ancorar(m):
        ancora = f'{slug}-{contador[0]}'
        contador[0] += 1
        subsecoes.append((re.sub(r'<[^>]+>', '', m.group(1)), ancora))
        return f'<h2 id="{ancora}">{m.group(1)}</h2>'

    saida = re.sub(r'<h2>(.*?)</h2>', ancorar, saida)
    return saida, subsecoes, len(diagramas)


def main() -> None:
    secoes, sumario, total_diagramas = [], [], 0

    for arquivo, slug, titulo in RELATORIOS:
        caminho = DOCS / arquivo
        if not caminho.exists():
            sys.exit(f"Relatório não encontrado: {caminho}")
        corpo, subsecoes, n = converter(caminho, slug)
        total_diagramas += n
        secoes.append({'slug': slug, 'titulo': titulo, 'html': corpo})
        sumario.append({'slug': slug, 'titulo': titulo, 'subs': subsecoes})

    trilho = ['<nav class="rail" aria-label="Sumário">',
              '<p class="rail-brand">Tech Challenge · Fase 5</p>']
    for i, grupo in enumerate(sumario):
        trilho.append('<div class="rail-group">')
        trilho.append(f'<a href="#{grupo["slug"]}"><span class="rail-num">{NUMEROS[i]}</span>'
                      f'<span>{html.escape(grupo["titulo"])}</span></a>')
        trilho.append('<ul class="rail-subs">')
        for rotulo, ancora in grupo['subs']:
            trilho.append(f'<li><a href="#{ancora}">{html.escape(rotulo)}</a></li>')
        trilho.append('</ul></div>')
    trilho.append('</nav>')

    compacto = ['<details class="compact-toc">',
                '<summary>Sumário dos três entregáveis</summary><ol>']
    for grupo in sumario:
        compacto.append(f'<li><a href="#{grupo["slug"]}">{html.escape(grupo["titulo"])}</a></li>')
    compacto.append('</ol></details>')

    blocos = []
    for i, secao in enumerate(secoes):
        blocos.append(f'''<section class="deliverable" id="{secao['slug']}">
  <header class="deliverable-head">
    <span class="deliverable-num">{NUMEROS[i]}</span>
    <h2>{html.escape(secao['titulo'])}</h2>
  </header>
  <div class="doc">
{secao['html']}
  </div>
</section>''')

    corpo_html = (RAIZ / 'scripts' / 'build-docs' / 'body.html').read_text()
    corpo_html = (corpo_html
                  .replace('<!--RAIL-->', ''.join(trilho))
                  .replace('<!--COMPACT_TOC-->', ''.join(compacto))
                  .replace('<!--SECTIONS-->', ''.join(blocos)))

    SAIDA.write_text(TEMPLATE.read_text() + corpo_html)
    print(f"{SAIDA.relative_to(RAIZ)} — {SAIDA.stat().st_size:,} bytes, "
          f"{len(secoes)} relatórios, {total_diagramas} diagramas")


if __name__ == '__main__':
    main()
