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
      return 'dark' as const;
    default:
      return 'default' as const;
  }
}

function getThemeVariables(theme: MermaidRenderTheme | undefined) {
  const isDark = theme === 'dark';
  return isDark
    ? {
        darkMode: true,
        background: 'transparent',
        mainBkg: '#2a2b2d',
        nodeBorder: '#4b4d52',
        nodeTextColor: '#f3f4f6',
        textColor: '#f3f4f6',
        lineColor: '#9ca3af',
        arrowheadColor: '#9ca3af',
        edgeLabelBackground: '#1f2937',
        primaryColor: '#2a2b2d',
        primaryTextColor: '#f3f4f6',
        primaryBorderColor: '#4b4d52',
        secondaryColor: '#374151',
        secondaryTextColor: '#f3f4f6',
        secondaryBorderColor: '#4b4d52',
        tertiaryColor: '#1f2937',
        tertiaryTextColor: '#f3f4f6',
        tertiaryBorderColor: '#374151',
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
    htmlLabels: false,
    fontFamily: options?.fontFamily ?? 'IBM Plex Mono',
    flowchart: { useMaxWidth: true, htmlLabels: false },
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

export async function renderClassicMermaidSvg(
  request: MermaidRenderRequest
): Promise<MermaidRenderResult> {
  return enqueueClassicMermaidRender(async () => {
    const mermaid = await loadMermaid();
    mermaid.initialize(createClassicMermaidConfig(request.options));

    const { svg } = await mermaid.render(createDiagramId(), request.code);
    return { svg };
  });
}
