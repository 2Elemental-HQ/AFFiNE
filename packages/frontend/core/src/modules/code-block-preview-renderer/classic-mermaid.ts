import type { Mermaid } from 'mermaid';

import type {
  MermaidRenderOptions,
  MermaidRenderRequest,
  MermaidRenderResult,
  MermaidRenderTheme,
} from '../mermaid/renderer';

let mermaidPromise: Promise<Mermaid> | null = null;
let mermaidRenderQueue: Promise<void> = Promise.resolve();

function toTheme(theme: MermaidRenderTheme | undefined) {
  switch (theme) {
    case 'modern':
      return 'base' as const;
    case 'dark':
      return 'base' as const;
    default:
      return 'base' as const;
  }
}

function getThemeVariables(theme: MermaidRenderTheme | undefined) {
  const isDark = theme === 'dark';
  return isDark
    ? {
        darkMode: true,
        background: 'transparent',
        mainBkg: '#2a2b2d',
        nodeBorder: '#64748b',
        nodeTextColor: '#f8fafc',
        textColor: '#f8fafc',
        lineColor: '#cbd5e1',
        arrowheadColor: '#cbd5e1',
        edgeLabelBackground: '#1e293b',
        primaryColor: '#2a2b2d',
        primaryTextColor: '#f8fafc',
        primaryBorderColor: '#64748b',
        secondaryColor: '#334155',
        secondaryTextColor: '#f8fafc',
        secondaryBorderColor: '#64748b',
        tertiaryColor: '#1e293b',
        tertiaryTextColor: '#f8fafc',
        tertiaryBorderColor: '#475569',
        clusterBkg: '#1e293b',
        clusterBorder: '#475569',
        labelBoxBkgColor: '#2a2b2d',
        labelBoxBorderColor: '#64748b',
        labelTextColor: '#f8fafc',
        loopTextColor: '#f8fafc',
        signalColor: '#cbd5e1',
        signalTextColor: '#f8fafc',
        actorLineColor: '#94a3b8',
      }
    : {
        darkMode: false,
        background: 'transparent',
        mainBkg: '#ffffff',
        nodeBorder: '#d1d5db',
        nodeTextColor: '#111827',
        textColor: '#111827',
        lineColor: '#4b5563',
        arrowheadColor: '#4b5563',
        edgeLabelBackground: '#f9fafb',
        primaryColor: '#ffffff',
        primaryTextColor: '#111827',
        primaryBorderColor: '#d1d5db',
        secondaryColor: '#f3f4f6',
        secondaryTextColor: '#111827',
        secondaryBorderColor: '#d1d5db',
        tertiaryColor: '#e5e7eb',
        tertiaryTextColor: '#111827',
        tertiaryBorderColor: '#d1d5db',
        clusterBkg: '#f8fafc',
        clusterBorder: '#e2e8f0',
        labelBoxBkgColor: '#f3f4f6',
        labelBoxBorderColor: '#d1d5db',
        labelTextColor: '#111827',
        loopTextColor: '#111827',
      };
}

function createClassicMermaidConfig(options?: MermaidRenderOptions) {
  const theme = toTheme(options?.theme);
  const fallbackVariables = getThemeVariables(options?.theme);
  return {
    startOnLoad: false,
    theme,
    themeVariables: {
      ...fallbackVariables,
      ...(options?.themeVariables ?? {}),
    },
    securityLevel: 'strict' as const,
    htmlLabels: true,
    fontFamily: options?.fontFamily ?? 'IBM Plex Mono, sans-serif',
    flowchart: { useMaxWidth: true, htmlLabels: true },
    sequence: { useMaxWidth: true },
    gantt: { useMaxWidth: true },
    pie: { useMaxWidth: true },
    journey: { useMaxWidth: true },
    gitGraph: { useMaxWidth: true },
  };
}

async function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then(module => module.default);
  }
  return mermaidPromise;
}

function createDiagramId() {
  return `mermaid-diagram-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function enqueueClassicMermaidRender<T>(task: () => Promise<T>): Promise<T> {
  const run = mermaidRenderQueue.then(task, task);
  mermaidRenderQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function hasCustomMermaidConfig(code: string): boolean {
  const trimmed = code.trim();
  // Check for YAML frontmatter: starts with --- and specifies custom theme/look
  if (trimmed.startsWith('---')) {
    const endFrontmatter = trimmed.indexOf('---', 3);
    if (endFrontmatter !== -1) {
      const frontmatter = trimmed.slice(3, endFrontmatter);
      if (frontmatter.includes('theme:') || frontmatter.includes('theme :') || frontmatter.includes('look:')) {
        return true;
      }
    }
  }
  // Check for %%{init: directive
  if (trimmed.startsWith('%%{init:')) {
    return true;
  }
  return false;
}

function adaptCodeForTheme(code: string, isDark: boolean): string {
  if (!isDark) {
    return code;
  }
  // If the diagram explicitly specifies a light-only theme in frontmatter or directive,
  // map it to its dark counterpart for legibility on dark backgrounds.
  let adapted = code
    .replace(/(theme:\s*['"]?)redux-color(['"]?)/g, '$1redux-dark-color$2')
    .replace(/(theme:\s*['"]?)default(['"]?)/g, '$1dark$2')
    .replace(/(theme:\s*['"]?)neutral(['"]?)/g, '$1dark$2');

  // If the diagram specifies a light rect background (like rect rgb(245,245,245)),
  // soften it in dark mode so it renders as a dark translucent plane rather than a stark white box.
  adapted = adapted.replace(
    /rect\s+rgb\(\s*(24\d|25[0-5])\s*,\s*(24\d|25[0-5])\s*,\s*(24\d|25[0-5])\s*\)/gi,
    'rect rgba(255, 255, 255, 0.05)'
  );

  return adapted;
}

export async function renderClassicMermaidSvg(
  request: MermaidRenderRequest
): Promise<MermaidRenderResult> {
  return enqueueClassicMermaidRender(async () => {
    const mermaid = await loadMermaid();
    const isDark = request.options?.theme === 'dark';
    const code = adaptCodeForTheme(request.code, isDark);
    const hasCustomConfig = hasCustomMermaidConfig(code);

    const baseConfig = createClassicMermaidConfig(request.options);
    if (hasCustomConfig) {
      // If the diagram provides its own config/frontmatter, avoid injecting
      // rigid themeVariables or overriding theme that clobber the user-specified theme.
      delete (baseConfig as any).themeVariables;
      delete (baseConfig as any).theme;
    }

    mermaid.initialize(baseConfig);

    const { svg } = await mermaid.render(createDiagramId(), code);
    return { svg };
  });
}
