/* ═════════════════════════════════════════════════════════════════
   Kastor Docs — entrypoint do bundle do editor
   ─────────────────────────────────────────────
   Este arquivo NÃO é servido diretamente. Ele é bundled via esbuild
   em `public/vendor/writer.bundle.js` (ver scripts/build-writer.js).
   Exponho tudo o que o app.js precisa no window.KastorWriter — assim
   evito misturar módulos ES6 com o app.js monolítico legado.
   ═════════════════════════════════════════════════════════════════ */
import { Editor, Extension, Node, Mark, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { Table } from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import Image from '@tiptap/extension-image';
import TextAlign from '@tiptap/extension-text-align';
import Underline from '@tiptap/extension-underline';
import { TextStyle, FontFamily, Color, FontSize } from '@tiptap/extension-text-style';
import Highlight from '@tiptap/extension-highlight';
// ── Novas features (task list, code highlight, mention) ──
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { createLowlight, common } from 'lowlight';
import Mention from '@tiptap/extension-mention';
import Suggestion from '@tiptap/suggestion';
// ── Colaboração realtime ──
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { prosemirrorJSONToYDoc } from 'y-prosemirror';

// Lowlight singleton com os langs "common" (js, ts, py, bash, css, html,
// json, md, sql, xml, yaml, etc). Suficiente pra 95% dos casos e ~40KB.
const lowlight = createLowlight(common);

/* Cria um editor Tiptap no elemento `mount`, com os defaults do Kastor.
   `opts.content`   = ProseMirror JSON inicial (ou null)
   `opts.editable`  = true por padrão
   `opts.onUpdate`  = callback(editor, json) chamado a cada change (debounce feito fora)
   `opts.onSelectionUpdate` = callback(editor) — usado pra sincronizar toolbar
   `opts.placeholder` = texto do placeholder no primeiro parágrafo vazio */
function createKastorEditor(mount, opts = {}) {
  const editor = new Editor({
    element: mount,
    editable: opts.editable !== false,
    autofocus: opts.autofocus === true ? 'start' : (opts.autofocus || false),
    content: opts.content || null,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        // StarterKit v3 já inclui Link e Underline — desabilitamos aqui e
        // adicionamos nossas versões configuradas explicitamente abaixo,
        // pra evitar "duplicate extension names".
        link: false,
        underline: false,
        // codeBlock desabilitado — usamos CodeBlockLowlight (com syntax
        // highlighting via lowlight) registrado abaixo.
        codeBlock: false
      }),
      Underline,
      Link.configure({
        openOnClick: false,           // clicar não navega dentro do editor
        HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' }
      }),
      Placeholder.configure({
        placeholder: opts.placeholder || 'Comece a escrever…',
        emptyEditorClass: 'is-editor-empty'
      }),
      Table.configure({ resizable: true, HTMLAttributes: { class: 'writer-table' } }),
      TableRow, TableHeader, TableCell,
      KdImage.configure({ HTMLAttributes: { class: 'writer-image' } }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      KastorAttachment,
      KastorComment,
      PasteAsLink,
      TextStyle,
      FontFamily,
      FontSize,
      Color,
      Highlight.configure({ multicolor: true }),
      KdBlockIndent,
      KdPagination,
      // ── Novos ──
      TaskList.configure({ HTMLAttributes: { class: 'kd-task-list' } }),
      TaskItem.configure({ nested: true, HTMLAttributes: { class: 'kd-task-item' } }),
      CodeBlockLowlight.configure({ lowlight, HTMLAttributes: { class: 'kd-code-block' } }),
      KdCallout,
      KdColumn,
      KdColumnBlock,
      KdMention,
      KdSlashCommand
    ],
    onUpdate: ({ editor }) => {
      if (typeof opts.onUpdate === 'function') {
        try { opts.onUpdate(editor, editor.getJSON()); } catch (e) { console.error('writer onUpdate:', e); }
      }
    },
    onSelectionUpdate: ({ editor }) => {
      if (typeof opts.onSelectionUpdate === 'function') {
        try { opts.onSelectionUpdate(editor); } catch (e) { console.error('writer onSelectionUpdate:', e); }
      }
    }
  });
  return editor;
}

/* Serializa o doc pra HTML — usado no export e nas prévias das cards. */
function editorToHTML(editor) {
  if (!editor) return '';
  return editor.getHTML();
}

/* Extrai texto puro (sem markup) — usado nas prévias e no export TXT. */
function editorToText(editor) {
  if (!editor) return '';
  return editor.getText();
}

/* Doc vazio no formato ProseMirror JSON — pra novos documentos. */
function emptyDoc() {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}

/* ───────────────────────────────────────────────────────────────
   Colaboração realtime
   ─────────────────────────────
   Cria um editor conectado a um Y.Doc via WebsocketProvider.
   `opts.docId`        — id do doc (rota WS = /rt/docs/<id>)
   `opts.wsUrl`        — URL base do WS (ex.: "ws://host:3000/rt/docs")
   `opts.initialJSON`  — PM JSON pra bootstrap se o Y.Doc do servidor
                         estiver vazio (primeiro cliente conecta)
   `opts.user`         — { name, color } — mostrado no caret dos outros
   `opts.placeholder`  — texto do placeholder
   `opts.onStatus`     — callback('connecting'|'connected'|'disconnected')
   `opts.onUpdate`     — callback(editor, json) — pra autosave de PM JSON
   `opts.onSelectionUpdate` — pra atualizar toolbar

   Retorna { editor, provider, ydoc, destroy() }
   ─────────────────────────────────────────────────────────────── */
function createCollabEditor(mount, opts) {
  const ydoc = new Y.Doc();
  const provider = new WebsocketProvider(opts.wsUrl, opts.docId, ydoc, {
    connect: true,
    // Não precisa passar params — auth é via cookie de sessão HTTP
  });

  if (typeof opts.onStatus === 'function') {
    provider.on('status', ({ status }) => {
      try { opts.onStatus(status); } catch {}
    });
  }

  // Awareness: identidade do usuário local
  // ATENÇÃO: campos como `id` e `avatar` são consumidos pela UI de presença
  // (renderPresence + miniperfil) do standalone.js. Se você mudar isto,
  // atualize também o consumidor.
  if (opts.user) {
    provider.awareness.setLocalStateField('user', {
      id:     opts.user.id     || null,
      name:   opts.user.name   || 'Usuário',
      color:  opts.user.color  || '#7A00FF',
      avatar: opts.user.avatar || null
    });
  }

  // Bootstrap: espera 1º sync. Se depois disso o Y.Doc estiver vazio
  // e temos initialJSON, seedamos aplicando um update construído do JSON.
  provider.once('synced', () => {
    if (!opts.initialJSON) return;
    const isEmpty = ydoc.getXmlFragment('default').length === 0
                 && ydoc.share.has('default') === false;
    if (isEmpty) {
      try {
        const seed = prosemirrorJSONToYDoc(_schemaFromExtensions(), opts.initialJSON);
        const upd = Y.encodeStateAsUpdate(seed);
        Y.applyUpdate(ydoc, upd);
      } catch (e) {
        console.warn('[collab] falha ao seed inicial:', e);
      }
    }
  });

  const editor = new Editor({
    element: mount,
    editable: opts.editable !== false,
    // Aceita true (= 'start') ou string ('start' | 'end' | posição) direto.
    // 'start' é o default agora — abrir um doc joga cursor no topo em vez do
    // fim, evitando que o browser scrolle o paper até o fim do conteúdo.
    autofocus: opts.autofocus === true ? 'start' : (opts.autofocus || false),
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        // codeBlock desabilitado — usamos CodeBlockLowlight abaixo.
        codeBlock: false,
        // StarterKit v3 embute link e underline — desabilita pra usar as
        // nossas versões configuradas (Link com target _blank, etc).
        link: false,
        underline: false,
        // Collaboration traz o próprio histórico (Yjs undo/redo). Se deixar
        // o undoRedo do StarterKit ativo, os dois conflitam e undo local
        // some. Sempre desabilitar quando usar Collaboration.
        undoRedo: false
      }),
      Underline,
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' }
      }),
      Placeholder.configure({
        placeholder: opts.placeholder || 'Comece a escrever…',
        emptyEditorClass: 'is-editor-empty'
      }),
      Table.configure({ resizable: true, HTMLAttributes: { class: 'writer-table' } }),
      TableRow, TableHeader, TableCell,
      KdImage.configure({ HTMLAttributes: { class: 'writer-image' } }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      KastorAttachment,
      KastorComment,
      PasteAsLink,
      TextStyle,
      FontFamily,
      FontSize,
      Color,
      Highlight.configure({ multicolor: true }),
      KdBlockIndent,
      KdPagination,
      // ── Novos ──
      TaskList.configure({ HTMLAttributes: { class: 'kd-task-list' } }),
      TaskItem.configure({ nested: true, HTMLAttributes: { class: 'kd-task-item' } }),
      CodeBlockLowlight.configure({ lowlight, HTMLAttributes: { class: 'kd-code-block' } }),
      KdCallout,
      KdColumn,
      KdColumnBlock,
      KdMention,
      KdSlashCommand,
      // Colab: substitui o history pelo Yjs undo/redo
      Collaboration.configure({ document: ydoc }),
      CollaborationCaret.configure({
        provider,
        // CollaborationCaret também chama awareness.setLocalStateField('user',...)
        // com este objeto, SOBRESCREVENDO o que setamos antes. Por isso repetimos
        // id/avatar aqui — sem eles a presence não consegue mostrar foto nem
        // habilitar o miniperfil.
        user: {
          id:     opts.user?.id     || null,
          name:   opts.user?.name   || 'Usuário',
          color:  opts.user?.color  || '#7A00FF',
          avatar: opts.user?.avatar || null
        }
      })
    ],
    onUpdate: ({ editor }) => {
      if (typeof opts.onUpdate === 'function') {
        try { opts.onUpdate(editor, editor.getJSON()); } catch {}
      }
    },
    onSelectionUpdate: ({ editor }) => {
      if (typeof opts.onSelectionUpdate === 'function') {
        try { opts.onSelectionUpdate(editor); } catch {}
      }
    }
  });

  return {
    editor, provider, ydoc,
    destroy() {
      try { editor.destroy(); } catch {}
      try { provider.destroy(); } catch {}
      try { ydoc.destroy(); } catch {}
    }
  };
}

/* ───────────────────────────────────────────────────────────────
   Node customizado: kastorAttachment
   ─────────────────────────────
   Um bloco atômico que representa 1 anexo da Galeria dentro do texto.
   Serializa como:
     <div data-kastor-att data-att-id data-name data-mime data-url data-size data-kind data-is-image>
   Renderiza inline como:
     - <img> se for imagem
     - card com ícone + nome + meta se for outro formato
   Ambos os casos: click → abre `data.viewerUrl` (que o standalone.js define
   antes de inserir), ou `data.url` (uploads) direto em nova aba como fallback.
   ─────────────────────────────────────────────────────────────── */
const KastorAttachment = Node.create({
  name: 'kastorAttachment',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      attachmentId: { default: null, parseHTML: e => e.getAttribute('data-att-id'), renderHTML: a => ({ 'data-att-id': a.attachmentId }) },
      name:         { default: '',   parseHTML: e => e.getAttribute('data-name'),   renderHTML: a => ({ 'data-name': a.name }) },
      mime:         { default: '',   parseHTML: e => e.getAttribute('data-mime'),   renderHTML: a => ({ 'data-mime': a.mime }) },
      url:          { default: '',   parseHTML: e => e.getAttribute('data-url'),    renderHTML: a => ({ 'data-url': a.url }) },
      size:         { default: 0,    parseHTML: e => Number(e.getAttribute('data-size') || 0), renderHTML: a => ({ 'data-size': String(a.size || 0) }) },
      kind:         { default: 'file', parseHTML: e => e.getAttribute('data-kind') || 'file', renderHTML: a => ({ 'data-kind': a.kind }) },
      isImage:      { default: false, parseHTML: e => e.getAttribute('data-is-image') === 'true', renderHTML: a => ({ 'data-is-image': String(!!a.isImage) }) }
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-kastor-att]' }];
  },

  // Pra y-prosemirror encodar o node corretamente ele precisa ver uma
  // representação DOM plana (leaf). Renderização rica fica no addNodeView.
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-kastor-att': 'true', class: 'kastor-att-node' })];
  },

  // NodeView pinta o conteúdo real com base nos attrs e adiciona os handlers
  // de click. É recriado quando o node é substituído — ideal pra Yjs.
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('div');
      dom.setAttribute('data-kastor-att', 'true');
      dom.className = 'kastor-att-node';
      // Reflete todos os attrs pra parseHTML round-trippar via HTML
      const a = node.attrs || {};
      dom.setAttribute('data-att-id',  a.attachmentId || '');
      dom.setAttribute('data-name',    a.name || '');
      dom.setAttribute('data-mime',    a.mime || '');
      dom.setAttribute('data-url',     a.url || '');
      dom.setAttribute('data-size',    String(a.size || 0));
      dom.setAttribute('data-kind',    a.kind || 'file');
      dom.setAttribute('data-is-image', String(!!a.isImage));

      if (a.isImage && a.url) {
        dom.innerHTML =
          `<a class="kastor-att-img-link" href="${_escAttr(a.url)}" target="_blank" rel="noopener">
             <img class="kastor-att-img" src="${_escAttr(a.url)}" alt="${_escAttr(a.name)}" loading="lazy">
           </a>`;
      } else {
        const ext = (a.name || '').split('.').pop().toUpperCase().slice(0, 5) || 'FILE';
        // Layout minimalista: só o nome e a extensão. Sem tamanho, sem borda,
        // sem estilo de link. Fica com peso visual leve dentro do texto.
        dom.innerHTML =
          `<a class="kastor-att-card" href="${_escAttr(a.url || '#')}" target="_blank" rel="noopener">
             <div class="kastor-att-name">${_escAttr(a.name || 'arquivo')}</div>
             <div class="kastor-att-ext">${_escAttr(ext)}</div>
           </a>`;
      }
      return { dom };
    };
  },

  addCommands() {
    return {
      insertKastorAttachment: (att) => ({ chain }) => chain().focus().insertContent({
        type: 'kastorAttachment',
        attrs: {
          attachmentId: att.attachmentId || att.id || null,
          name: att.name || '',
          mime: att.mime || att.type || '',
          url: att.url || '',
          size: att.size || 0,
          kind: att.kind || 'file',
          isImage: !!(att.isImage || /^image\//i.test(att.mime || att.type || ''))
        }
      }).createParagraphNear().run()
    };
  }
});

/* ───────────────────────────────────────────────────────────────
   Extension: PasteAsLink
   ─────────────────────────────
   Se o user cola uma URL enquanto tem texto selecionado, transforma
   a seleção num link com aquela URL — em vez de substituir pelo texto
   da URL. Padrão Google Docs / Notion.
   ─────────────────────────────────────────────────────────────── */
const URL_REGEX = /^https?:\/\/[^\s]+$/i;
const PasteAsLink = Extension.create({
  name: 'kastorPasteAsLink',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handlePaste(view, event) {
            const text = event.clipboardData && event.clipboardData.getData('text/plain');
            if (!text) return false;
            const trimmed = text.trim();
            if (!URL_REGEX.test(trimmed)) return false;
            const { from, to, empty } = view.state.selection;
            if (empty) return false; // sem seleção, comportamento padrão (cola URL)
            const markType = view.state.schema.marks.link;
            if (!markType) return false;
            event.preventDefault();
            const tr = view.state.tr.addMark(from, to, markType.create({ href: trimmed }));
            view.dispatch(tr);
            return true;
          }
        }
      })
    ];
  }
});

/* ───────────────────────────────────────────────────────────────
   Mark customizado: kastorComment
   ─────────────────────────────
   Highlight amarelo suave que ancora um thread de comentário. O attr
   `data-thread-id` casa 1:1 com uma thread no back-end. Click no mark
   emite um CustomEvent('kastor-comment-click', { threadId }) que o
   standalone.js escuta pra abrir o painel na thread certa.
   ─────────────────────────────────────────────────────────────── */
const KastorComment = Mark.create({
  name: 'kastorComment',
  inclusive: false,      // não estende ao digitar fora do range
  // NOTA: omitir `excludes` (default é auto-exclusão do mesmo mark type).
  // Se colocar `excludes: ''` (overlapping), o y-prosemirror serializa o
  // attribute como `kastorComment--<hash>` na Y.XmlText — a chave tem `--`
  // que causa colisão no round-trip e y-prosemirror deleta o texto inteiro.
  addOptions() { return { HTMLAttributes: {} }; },

  addAttributes() {
    return {
      threadId: {
        default: null,
        parseHTML: e => e.getAttribute('data-thread-id'),
        renderHTML: a => a.threadId ? { 'data-thread-id': a.threadId } : {}
      }
    };
  },

  parseHTML() { return [{ tag: 'span[data-thread-id]' }]; },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { class: 'kastor-comment-mark' }), 0];
  },

  addCommands() {
    return {
      setKastorComment: (threadId) => ({ chain }) =>
        chain().setMark(this.name, { threadId }).run(),
      unsetKastorComment: () => ({ chain }) =>
        chain().unsetMark(this.name).run(),
      unsetKastorCommentById: (threadId) => ({ tr, state, dispatch }) => {
        // Percorre o doc e remove marks com esse threadId
        let changed = false;
        state.doc.descendants((node, pos) => {
          const m = node.marks.find(mk => mk.type.name === 'kastorComment' && mk.attrs.threadId === threadId);
          if (m) {
            tr.removeMark(pos, pos + node.nodeSize, m);
            changed = true;
          }
        });
        if (changed && dispatch) dispatch(tr);
        return changed;
      }
    };
  }
});

function _escAttr(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function _fmtSize(bytes) {
  if (!bytes) return '—';
  const u = ['B','KB','MB','GB'];
  let i = 0; let n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
}

// Helper: extrai o Schema ProseMirror do editor pra usar em prosemirrorJSONToYDoc
// (precisamos do schema real, não recriar). Cria um editor temporário só pra pegar.
let _cachedSchema = null;
function _schemaFromExtensions() {
  if (_cachedSchema) return _cachedSchema;
  const tmpMount = document.createElement('div');
  const tmpEditor = new Editor({
    element: tmpMount,
    extensions: [
      // Precisa refletir TODAS as extensions dos editores reais senão o
      // prosemirrorJSONToYDoc dropa nodes desconhecidos durante seed inicial.
      StarterKit.configure({ heading: { levels: [1, 2, 3] }, codeBlock: false, link: false, underline: false }),
      Underline, Link, Placeholder,
      Table, TableRow, TableHeader, TableCell,
      KdImage, TextAlign.configure({ types: ['heading', 'paragraph'] }),
      KastorAttachment, KastorComment, PasteAsLink,
      TextStyle, FontFamily, FontSize, Color, Highlight.configure({ multicolor: true }),
      KdBlockIndent,
      TaskList, TaskItem.configure({ nested: true }),
      CodeBlockLowlight.configure({ lowlight }),
      KdCallout, KdColumn, KdColumnBlock, KdMention
    ]
  });
  _cachedSchema = tmpEditor.schema;
  tmpEditor.destroy();
  return _cachedSchema;
}

// Namespace global exposto pro app.js legado

/* ── KdImage: extende Image com width + align ─────────────────────────
   TipTap's Image não tem esses attrs por padrão. Adicionamos aqui pra
   permitir resize via handles/right-click e alinhamento (left/center/right).
   width pode ser número (px) ou string ("50%"), renderizado no style. */
const KdImage = Image.extend({
  addAttributes() {
    return {
      ...(this.parent?.() || {}),
      width: {
        default: null,
        renderHTML: (attrs) => {
          if (attrs.width == null || attrs.width === '') return {};
          const v = typeof attrs.width === 'number' ? attrs.width + 'px' : String(attrs.width);
          return { style: 'width:' + v };
        },
        parseHTML: (el) => {
          const w = el.getAttribute('width') || (el.style && el.style.width) || '';
          if (!w) return null;
          if (w.endsWith('%')) return w;
          const n = parseInt(w, 10);
          return Number.isFinite(n) ? n : null;
        }
      },
      align: {
        default: null,
        renderHTML: (attrs) => attrs.align ? { 'data-align': attrs.align } : {},
        parseHTML: (el) => el.getAttribute('data-align') || null
      }
    };
  }
});

/* ── Callout: bloco de destaque (Nota/Aviso/Dica/Importante) ────────
   Container com background colorido + ícone + conteúdo editável.
   Cor/ícone vêm do attr `variant` (info/warn/tip/danger). Renderiza
   como <div class="kd-callout kd-callout--warn">. Aceita qualquer bloco
   dentro (parágrafos, listas, etc). Fica GROUP block pra permitir mistura. */
const KdCallout = Node.create({
  name: 'kdCallout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      variant: {
        default: 'info',
        parseHTML: (el) => el.getAttribute('data-variant') || 'info',
        renderHTML: (attrs) => ({ 'data-variant': attrs.variant || 'info' })
      }
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-callout]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-callout': 'true', class: 'kd-callout' }), 0];
  },
  addCommands() {
    return {
      setCallout: (attrs = {}) => ({ commands }) => {
        return commands.wrapIn(this.name, { variant: attrs.variant || 'info' });
      },
      unsetCallout: () => ({ commands }) => commands.lift(this.name),
      toggleCallout: (attrs = {}) => ({ state, commands }) => {
        const isInCallout = state.selection.$from.node(-1)?.type.name === this.name
                         || state.selection.$from.parent.type.name === this.name;
        return isInCallout ? commands.lift(this.name) : commands.wrapIn(this.name, { variant: attrs.variant || 'info' });
      }
    };
  }
});

/* ── Colunas: bloco container multi-coluna (2 ou 3 colunas) ─────────
   kdColumnBlock = wrapper com N .kd-column dentro.
   kdColumn      = célula editável (aceita blocos).
   Renderiza como CSS grid. Attr `cols` controla número de colunas.
   Ao inserir, cria automaticamente N kdColumn com um parágrafo vazio cada. */
const KdColumn = Node.create({
  name: 'kdColumn',
  group: 'kdColumn',
  content: 'block+',
  defining: true,
  isolating: true,
  parseHTML() { return [{ tag: 'div[data-column]' }]; },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-column': 'true', class: 'kd-column' }), 0];
  }
});
const KdColumnBlock = Node.create({
  name: 'kdColumnBlock',
  group: 'block',
  content: 'kdColumn{2,3}',       // exige 2 ou 3 kdColumns
  addAttributes() {
    return {
      cols: {
        default: 2,
        parseHTML: (el) => parseInt(el.getAttribute('data-cols') || '2', 10),
        renderHTML: (attrs) => ({ 'data-cols': String(attrs.cols || 2), style: 'grid-template-columns: repeat(' + (attrs.cols || 2) + ', 1fr)' })
      }
    };
  },
  parseHTML() { return [{ tag: 'div[data-column-block]' }]; },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-column-block': 'true', class: 'kd-column-block' }), 0];
  },
  addCommands() {
    return {
      setColumns: (n = 2) => ({ chain, state }) => {
        const cols = Math.max(2, Math.min(3, Number(n) || 2));
        const emptyPara = { type: 'paragraph' };
        const kdCol = { type: 'kdColumn', content: [emptyPara] };
        return chain().insertContent({
          type: 'kdColumnBlock',
          attrs: { cols },
          content: new Array(cols).fill(null).map(() => kdCol)
        }).run();
      }
    };
  }
});

/* ── Mention: renderiza @nome como chip clicável ──────────────────── */
const KdMentionSuggestion = {
  char: '@',
  allowSpaces: false,
  startOfLine: false,
  items: ({ query }) => {
    // Delegado pra window.kdMentionItems se existir (populado pelo standalone.js
    // com a lista de usuários do docs), senão array vazio.
    if (typeof window !== 'undefined' && typeof window.kdMentionItems === 'function') {
      try { return window.kdMentionItems(query) || []; } catch { return []; }
    }
    return [];
  },
  render: () => {
    let popup, selectedIndex = 0, currentItems = [];
    const render = (props) => {
      if (!popup) {
        popup = document.createElement('div');
        popup.className = 'kd-mention-popup';
        document.body.appendChild(popup);
      }
      currentItems = props.items || [];
      selectedIndex = 0;
      draw(props);
      position(props);
    };
    const draw = (props) => {
      if (!currentItems.length) {
        popup.innerHTML = '<div class="kd-mention-empty">Nenhum usuário</div>';
        return;
      }
      popup.innerHTML = currentItems.map((it, i) => {
        const avatar = it.avatar
          ? `<img src="${it.avatar}" alt="" class="kd-mention-avatar">`
          : `<div class="kd-mention-avatar kd-mention-avatar--initial" style="background:${it.color || '#7A00FF'}">${(it.name || '?').charAt(0).toUpperCase()}</div>`;
        return `<button type="button" data-i="${i}" class="kd-mention-item${i === selectedIndex ? ' is-selected' : ''}">
          ${avatar}<span class="kd-mention-name">${escapeHtml(it.name || '')}</span>
          ${it.role ? `<span class="kd-mention-role">${escapeHtml(it.role)}</span>` : ''}
        </button>`;
      }).join('');
      popup.querySelectorAll('.kd-mention-item').forEach(el => {
        el.addEventListener('mousedown', (e) => {
          e.preventDefault();
          const i = parseInt(el.dataset.i, 10);
          props.command({ id: currentItems[i].id, label: currentItems[i].name });
        });
      });
    };
    const position = (props) => {
      const rect = props.clientRect?.();
      if (!rect) return;
      const pw = popup.offsetWidth;
      const ph = popup.offsetHeight;
      let x = rect.left, y = rect.bottom + 4;
      if (x + pw > window.innerWidth - 8) x = window.innerWidth - pw - 8;
      if (y + ph > window.innerHeight - 8) y = rect.top - ph - 4;
      popup.style.left = x + 'px';
      popup.style.top = y + 'px';
    };
    return {
      onStart: render,
      onUpdate: render,
      onKeyDown: (props) => {
        const k = props.event.key;
        if (k === 'ArrowDown') { selectedIndex = (selectedIndex + 1) % Math.max(1, currentItems.length); draw(props); return true; }
        if (k === 'ArrowUp')   { selectedIndex = (selectedIndex - 1 + currentItems.length) % Math.max(1, currentItems.length); draw(props); return true; }
        if (k === 'Enter' || k === 'Tab') {
          if (currentItems[selectedIndex]) {
            props.command({ id: currentItems[selectedIndex].id, label: currentItems[selectedIndex].name });
            return true;
          }
          return false;
        }
        if (k === 'Escape') { popup?.remove(); popup = null; return true; }
        return false;
      },
      onExit: () => { popup?.remove(); popup = null; }
    };
  }
};
const KdMention = Mention.configure({
  HTMLAttributes: { class: 'kd-mention' },
  renderText: ({ node }) => `@${node.attrs.label || node.attrs.id}`,
  suggestion: KdMentionSuggestion
});

/* ── Slash command: menu contextual em `/` pra inserir bloco ────────
   Reusa @tiptap/suggestion (mesma libs do Mention). Ao digitar `/`,
   abre popup com lista de comandos (heading, list, callout, table…).
   Executor de cada comando fica no `command` do item. */
function _matchSlash(query, cmd) {
  const q = query.toLowerCase();
  return cmd.title.toLowerCase().includes(q)
      || (cmd.keywords || []).some(k => k.toLowerCase().includes(q));
}
const KdSlashCommands = [
  { key: 'h1', title: 'Título 1',            keywords: ['h1','título','heading'],       icon: 'H1', run: (ed, r) => ed.chain().deleteRange(r).setNode('heading', { level: 1 }).run() },
  { key: 'h2', title: 'Título 2',            keywords: ['h2','subtítulo'],              icon: 'H2', run: (ed, r) => ed.chain().deleteRange(r).setNode('heading', { level: 2 }).run() },
  { key: 'h3', title: 'Título 3',            keywords: ['h3'],                          icon: 'H3', run: (ed, r) => ed.chain().deleteRange(r).setNode('heading', { level: 3 }).run() },
  { key: 'p',  title: 'Parágrafo',           keywords: ['p','paragrafo','texto'],       icon: '¶',  run: (ed, r) => ed.chain().deleteRange(r).setNode('paragraph').run() },
  { key: 'ul', title: 'Lista com marcadores', keywords: ['lista','bullet','ul'],        icon: '•',  run: (ed, r) => ed.chain().deleteRange(r).toggleBulletList().run() },
  { key: 'ol', title: 'Lista numerada',      keywords: ['numerada','ordenada','ol'],    icon: '1.', run: (ed, r) => ed.chain().deleteRange(r).toggleOrderedList().run() },
  { key: 'task', title: 'Lista de tarefas',  keywords: ['todo','task','checkbox'],      icon: '☑',  run: (ed, r) => ed.chain().deleteRange(r).toggleTaskList().run() },
  { key: 'quote', title: 'Citação',          keywords: ['quote','citação','blockquote'], icon: '"',  run: (ed, r) => ed.chain().deleteRange(r).toggleBlockquote().run() },
  { key: 'code', title: 'Bloco de código',   keywords: ['code','codigo'],               icon: '</>', run: (ed, r) => ed.chain().deleteRange(r).toggleCodeBlock().run() },
  { key: 'hr', title: 'Linha divisória',     keywords: ['hr','divisor','divisória'],    icon: '—',  run: (ed, r) => ed.chain().deleteRange(r).setHorizontalRule().run() },
  { key: 'table', title: 'Tabela',           keywords: ['table','tabela'],              icon: '▦',  run: (ed, r) => ed.chain().deleteRange(r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { key: 'callout-info',   title: 'Nota',       keywords: ['nota','info','callout'],   icon: 'ℹ',  run: (ed, r) => ed.chain().deleteRange(r).setCallout({ variant: 'info' }).run() },
  { key: 'callout-tip',    title: 'Dica',       keywords: ['dica','tip'],              icon: '💡', run: (ed, r) => ed.chain().deleteRange(r).setCallout({ variant: 'tip' }).run() },
  { key: 'callout-warn',   title: 'Aviso',      keywords: ['aviso','warn','atenção'],  icon: '⚠',  run: (ed, r) => ed.chain().deleteRange(r).setCallout({ variant: 'warn' }).run() },
  { key: 'callout-danger', title: 'Importante', keywords: ['danger','importante','!!'], icon: '🚨', run: (ed, r) => ed.chain().deleteRange(r).setCallout({ variant: 'danger' }).run() },
  { key: 'cols2', title: '2 colunas',        keywords: ['colunas','cols','2'],          icon: '⫲',  run: (ed, r) => ed.chain().deleteRange(r).setColumns(2).run() },
  { key: 'cols3', title: '3 colunas',        keywords: ['colunas','cols','3'],          icon: '⫸',  run: (ed, r) => ed.chain().deleteRange(r).setColumns(3).run() }
];
const KdSlashCommand = Extension.create({
  name: 'kdSlashCommand',
  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        char: '/',
        allowSpaces: false,
        startOfLine: false,
        // Ativa só quando `/` está no COMEÇO de um bloco vazio ou de linha
        // (evita popup atrapalhando quando user digita `and/or`).
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          const isRootDepth = $from.depth === 1;
          const isAfterContent = $from.parent.textContent.slice(0, range.from - $from.start() - 1).trim().length > 0;
          return isRootDepth && !isAfterContent;
        },
        items: ({ query }) => KdSlashCommands.filter(c => _matchSlash(query, c)),
        command: ({ editor, range, props }) => {
          try { props.run(editor, range); } catch (e) { console.error('[slash]', e); }
        },
        render: () => {
          let popup, selectedIndex = 0, currentItems = [];
          const draw = (props) => {
            if (!currentItems.length) {
              popup.innerHTML = '<div class="kd-slash-empty">Nada bate com isso</div>';
              return;
            }
            popup.innerHTML = currentItems.map((it, i) => `
              <button type="button" data-i="${i}" class="kd-slash-item${i === selectedIndex ? ' is-selected' : ''}">
                <span class="kd-slash-icon">${it.icon}</span>
                <span class="kd-slash-title">${escapeHtml(it.title)}</span>
              </button>
            `).join('');
            popup.querySelectorAll('.kd-slash-item').forEach(el => {
              el.addEventListener('mousedown', (e) => {
                e.preventDefault();
                const i = parseInt(el.dataset.i, 10);
                props.command(currentItems[i]);
              });
            });
          };
          const position = (props) => {
            const rect = props.clientRect?.();
            if (!rect) return;
            const pw = popup.offsetWidth || 280;
            const ph = popup.offsetHeight || 200;
            let x = rect.left, y = rect.bottom + 4;
            if (x + pw > window.innerWidth - 8) x = window.innerWidth - pw - 8;
            if (y + ph > window.innerHeight - 8) y = rect.top - ph - 4;
            popup.style.left = x + 'px';
            popup.style.top = y + 'px';
          };
          return {
            onStart: (props) => {
              popup = document.createElement('div');
              popup.className = 'kd-slash-popup';
              document.body.appendChild(popup);
              currentItems = props.items || [];
              selectedIndex = 0;
              draw(props);
              position(props);
            },
            onUpdate: (props) => {
              currentItems = props.items || [];
              selectedIndex = Math.min(selectedIndex, Math.max(0, currentItems.length - 1));
              draw(props);
              position(props);
            },
            onKeyDown: (props) => {
              const k = props.event.key;
              if (k === 'ArrowDown') { selectedIndex = (selectedIndex + 1) % Math.max(1, currentItems.length); draw(props); return true; }
              if (k === 'ArrowUp')   { selectedIndex = (selectedIndex - 1 + currentItems.length) % Math.max(1, currentItems.length); draw(props); return true; }
              if (k === 'Enter') {
                if (currentItems[selectedIndex]) { props.command(currentItems[selectedIndex]); return true; }
                return false;
              }
              if (k === 'Escape') { popup?.remove(); popup = null; return true; }
              return false;
            },
            onExit: () => { popup?.remove(); popup = null; }
          };
        }
      })
    ];
  }
});

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* ── Indent (margens de parágrafo) ───────────────────────────────────
   Adiciona atributos `indentLeft` e `indentRight` (em mm) nos blocos
   (paragraph, heading, listas, blockquote). Renderizados como inline
   style: margin-left/right. Usados pela régua pra deslocar blocos. */
const KdBlockIndent = Extension.create({
  name: 'kdBlockIndent',
  addGlobalAttributes() {
    // Combina indent left/right + first-line indent num único `style`
    // (browsers ignoram atributos style múltiplos — precisa ser 1 string).
    const buildStyle = (a) => {
      const parts = [];
      if (a.indentLeft)       parts.push('margin-left:' + a.indentLeft + 'mm');
      if (a.indentRight)      parts.push('margin-right:' + a.indentRight + 'mm');
      if (a.firstLineIndent)  parts.push('text-indent:' + a.firstLineIndent + 'mm');
      return parts.length ? { style: parts.join(';') } : {};
    };
    return [{
      types: ['paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote'],
      attributes: {
        indentLeft: {
          default: 0,
          renderHTML: buildStyle,
          parseHTML: (el) => {
            const m = parseFloat(el.style.marginLeft);
            return isFinite(m) ? Math.round(m * 10) / 10 : 0;
          }
        },
        indentRight: {
          default: 0,
          // Não renderiza standalone — buildStyle acima já foi chamado no primeiro attr
          renderHTML: () => ({}),
          parseHTML: (el) => {
            const m = parseFloat(el.style.marginRight);
            return isFinite(m) ? Math.round(m * 10) / 10 : 0;
          }
        },
        firstLineIndent: {
          default: 0,
          renderHTML: () => ({}),
          parseHTML: (el) => {
            const m = parseFloat(el.style.textIndent);
            return isFinite(m) ? Math.round(m * 10) / 10 : 0;
          }
        }
      }
    }];
  },
  addCommands() {
    return {
      setBlockIndent: (attrs) => ({ tr, state, dispatch }) => {
        const { from, to } = state.selection;
        const types = ['paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote'];
        let modified = false;
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (types.includes(node.type.name)) {
            const newAttrs = { ...node.attrs };
            if (attrs.indentLeft       != null) newAttrs.indentLeft       = Math.max(0, attrs.indentLeft);
            if (attrs.indentRight      != null) newAttrs.indentRight      = Math.max(0, attrs.indentRight);
            if (attrs.firstLineIndent  != null) newAttrs.firstLineIndent  = Math.max(0, attrs.firstLineIndent);
            if (dispatch) tr.setNodeMarkup(pos, undefined, newAttrs);
            modified = true;
          }
        });
        return modified;
      }
    };
  }
});

/* ── Pagination — decorações que aplicam margin-top em blocos específicos ──
   ProseMirror sobrescreve inline styles no próximo microtask (reflete o
   estado do doc no DOM). Pra empurrar visualmente um bloco pra próxima
   página SEM alterar o doc, usamos decorações do tipo `Decoration.node`
   que aplicam `style="margin-top:XXpx"` ao node correspondente. */
const kdPaginationKey = new PluginKey('kdPagination');
const KdPagination = Extension.create({
  name: 'kdPagination',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: kdPaginationKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, old) {
            const meta = tr.getMeta(kdPaginationKey);
            if (meta) return meta;
            // Remapeia pra novas posições em cada transação
            return old.map(tr.mapping, tr.doc);
          }
        },
        props: {
          decorations(state) { return kdPaginationKey.getState(state); }
        }
      })
    ];
  }
});

/* Aplica pushes de pagination na view. `pushes` = array de { pos, marginTop }
   onde `pos` é a posição do node top-level e `marginTop` o valor em px.
   Chamado do standalone.js após medir os blocos no DOM. */
function setKdPaginationPushes(editor, pushes) {
  if (!editor || !editor.view) return;
  const doc = editor.view.state.doc;
  const decos = [];
  for (const p of (pushes || [])) {
    if (p.pos == null || !p.marginTop) continue;
    try {
      const node = doc.nodeAt(p.pos);
      if (!node) continue;
      decos.push(Decoration.node(p.pos, p.pos + node.nodeSize, {
        style: 'margin-top:' + p.marginTop + 'px'
      }));
    } catch (_) {}
  }
  const set = decos.length ? DecorationSet.create(doc, decos) : DecorationSet.empty;
  const tr = editor.view.state.tr.setMeta(kdPaginationKey, set);
  editor.view.dispatch(tr);
}

/* Editor somente-leitura — usado no viewer público. Sem colab (não conecta
   ao WS), sem autosave, sem toolbar. Só renderiza o PM JSON e permite scroll
   + seleção de texto pra o visitante copiar. */
function createReadOnlyEditor(mount, opts = {}) {
  return {
    editor: createKastorEditor(mount, {
      content: opts.initialJSON || null,
      editable: false,
      autofocus: false,
      placeholder: 'Documento vazio',
      onUpdate: () => {},
      onSelectionUpdate: () => {}
    })
  };
}

window.KastorWriter = {
  createEditor: createKastorEditor,
  createCollabEditor,
  createReadOnlyEditor,
  toHTML: editorToHTML,
  toText: editorToText,
  emptyDoc,
  setPaginationPushes: setKdPaginationPushes,
  version: '0.2.0'
};
