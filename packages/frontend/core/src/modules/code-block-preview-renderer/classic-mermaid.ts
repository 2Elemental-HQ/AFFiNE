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
        clusterBkg: '#1f2937',
        clusterBorder: '#374151',
        labelBoxBkgColor: '#2a2b2d',
        labelBoxBorderColor: '#4b4d52',
        labelTextColor: '#f3f4f6',
        loopTextColor: '#f3f4f6',
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
  // Check for YAML frontmatter: starts with --- and has config: or theme:
  if (trimmed.startsWith('---')) {
    const endFrontmatter = trimmed.indexOf('---', 3);
    if (endFrontmatter !== -1) {
      const frontmatter = trimmed.slice(3, endFrontmatter);
      if (frontmatter.includes('theme') || frontmatter.includes('config')) {
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

export async function renderClassicMermaidSvg(
  request: MermaidRenderRequest
): Promise<MermaidRenderResult> {
  return enqueueClassicMermaidRender(async () => {
    const mermaid = await loadMermaid();
    const hasCustomConfig = hasCustomMermaidConfig(request.code);

    const baseConfig = createClassicMermaidConfig(request.options);
    if (hasCustomConfig) {
      // If the diagram provides its own config/frontmatter, avoid injecting
      // rigid themeVariables that clobber the user-specified theme.
      delete (baseConfig as any).themeVariables;
    }

    mermaid.initialize(baseConfig);

    const { svg } = await mermaid.render(createDiagramId(), request.code);
    return { svg };
  });
}
