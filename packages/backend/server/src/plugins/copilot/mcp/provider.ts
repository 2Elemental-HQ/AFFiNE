import { Injectable } from '@nestjs/common';
import { McpAccessMode } from '@prisma/client';
import { nanoid } from 'nanoid';
import * as Y from 'yjs';
import z from 'zod/v3';

import { EventBus } from '../../../base';
import { DocReader, DocWriter } from '../../../core/doc';
import { PgWorkspaceDocStorageAdapter } from '../../../core/doc/adapters/workspace';
import type { DocRecord } from '../../../core/doc/storage';
import { PermissionAccess } from '../../../core/permission';
import { parseDocToMarkdownFromDocSnapshot } from '../../../core/utils/blocksuite';
import { Models } from '../../../models';
import { DocumentRetrievalService } from '../retrieval/document';

type McpTextContent = {
  type: 'text';
  text: string;
};

export type WorkspaceMcpToolResult = {
  content: McpTextContent[];
  isError?: boolean;
};

export type WorkspaceMcpToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (
    args: Record<string, unknown>,
    options: { signal: AbortSignal }
  ) => Promise<WorkspaceMcpToolResult>;
};

export type WorkspaceMcpServer = {
  name: string;
  version: string;
  tools: WorkspaceMcpToolDefinition[];
};

type ToolExecutorInput<T extends z.ZodTypeAny> = {
  name: string;
  title: string;
  description: string;
  parser: T;
  inputSchema: Record<string, unknown>;
  execute: (
    args: z.infer<T>,
    options: { signal: AbortSignal }
  ) => Promise<WorkspaceMcpToolResult>;
};

function toolText(text: string): WorkspaceMcpToolResult {
  return {
    content: [{ type: 'text', text }],
  };
}

function toolError(message: string): WorkspaceMcpToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

function toInputError(error: z.ZodError) {
  const details = error.issues
    .map(issue => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
  return toolError(`Invalid arguments: ${details || 'Invalid input'}`);
}

function abortIfNeeded(
  signal: AbortSignal
): WorkspaceMcpToolResult | undefined {
  if (signal.aborted) return toolError('Request aborted.');
  return;
}

function defineTool<T extends z.ZodTypeAny>(
  config: ToolExecutorInput<T>
): WorkspaceMcpToolDefinition {
  return {
    name: config.name,
    title: config.title,
    description: config.description,
    inputSchema: config.inputSchema,
    execute: async (args, options) => {
      const aborted = abortIfNeeded(options.signal);
      if (aborted) return aborted;

      const parsed = config.parser.safeParse(args ?? {});
      if (!parsed.success) return toInputError(parsed.error);
      return await config.execute(parsed.data, options);
    },
  };
}

const folderDocIdCache = new Map<string, string>();

async function loadFoldersYDoc(
  storage: PgWorkspaceDocStorageAdapter,
  models: Models,
  workspaceId: string
): Promise<{
  ydoc: Y.Doc;
  bin: Uint8Array | null;
  targetDocId: string;
  allDocIds: string[];
}> {
  // 1. Check in-memory cache first
  const cachedDocId = folderDocIdCache.get(workspaceId);
  if (cachedDocId) {
    const rec = await storage.getDoc(workspaceId, cachedDocId);
    if (rec?.bin && rec.bin.length > 0) {
      const ydoc = new Y.Doc({ guid: cachedDocId });
      Y.applyUpdate(ydoc, rec.bin);
      return { ydoc, bin: rec.bin, targetDocId: cachedDocId, allDocIds: [] };
    }
  }

  // 2. Direct O(1) indexed point lookups on known standard candidates
  const fixedCandidates = [
    'db$folders',
    `db$${workspaceId}$folders`,
    'db$folder',
    `db$${workspaceId}$folder`,
  ];

  for (const cand of fixedCandidates) {
    const rec = await storage.getDoc(workspaceId, cand);
    if (rec?.bin && rec.bin.length > 0) {
      folderDocIdCache.set(workspaceId, cand);
      const ydoc = new Y.Doc({ guid: cand });
      Y.applyUpdate(ydoc, rec.bin);
      return { ydoc, bin: rec.bin, targetDocId: cand, allDocIds: [] };
    }
  }

  // 3. Fallback only if no standard folder table was found: check DB doc timestamps
  let allDocIds: string[] = [];
  try {
    const docMap = await models.doc.findTimestampsByWorkspaceId(workspaceId);
    allDocIds = Object.keys(docMap);
  } catch {
    // ignore
  }

  const extraCandidates = allDocIds.filter(
    id =>
      (id.startsWith('db$') || id.includes('$')) &&
      id.toLowerCase().includes('folder')
  );

  let selectedDocId = 'db$folders';
  let selectedRecord: DocRecord | null = null;

  for (const cand of extraCandidates) {
    const rec = await storage.getDoc(workspaceId, cand);
    if (rec?.bin && rec.bin.length > 0) {
      selectedDocId = cand;
      selectedRecord = rec;
      folderDocIdCache.set(workspaceId, cand);
      break;
    }
  }

  if (!selectedRecord) {
    selectedDocId = allDocIds.some(
      id => id === `db$${workspaceId}$docProperties`
    )
      ? `db$${workspaceId}$folders`
      : 'db$folders';
    folderDocIdCache.set(workspaceId, selectedDocId);
  }

  const ydoc = new Y.Doc({ guid: selectedDocId });
  if (selectedRecord?.bin) {
    Y.applyUpdate(ydoc, selectedRecord.bin);
  }

  return {
    ydoc,
    bin: selectedRecord?.bin ?? null,
    targetDocId: selectedDocId,
    allDocIds,
  };
}

function parseFoldersYDoc(ydoc: Y.Doc) {
  const folders: Array<{
    id: string;
    name: string;
    parentId: string | null;
    index: string;
  }> = [];
  const docLinks: Array<{
    id: string;
    docId: string;
    folderId: string;
    index: string;
  }> = [];
  const rawRecords: any[] = [];

  for (const key of ydoc.share.keys()) {
    const map = ydoc.getMap(key);
    const json = typeof map.toJSON === 'function' ? map.toJSON() : {};
    rawRecords.push({ key, ...json });

    if (json.$$DELETED || (map as any).get?.('$$DELETED')) continue;
    const id = json.id || (map as any).get?.('id') || key;
    const parentId = json.parentId ?? (map as any).get?.('parentId') ?? null;
    const type = json.type ?? (map as any).get?.('type');
    const data = json.data ?? (map as any).get?.('data');
    const index = json.index ?? (map as any).get?.('index') ?? '';

    if (type === 'folder' && data) {
      folders.push({ id, name: String(data), parentId: parentId ? String(parentId) : null, index: String(index) });
    } else if (type === 'doc' && data && parentId) {
      docLinks.push({ id, docId: String(data), folderId: String(parentId), index: String(index) });
    }
  }
  return { folders, docLinks, rawRecords };
}

type WorkspaceDocMetaItem = {
  id: string;
  title: string;
  trash: boolean;
  createDate?: number;
  updatedDate?: number;
};

async function loadRootDoc(
  storage: PgWorkspaceDocStorageAdapter,
  workspaceId: string
): Promise<{
  rootYDoc: Y.Doc;
  pages: WorkspaceDocMetaItem[];
  pageIdToStorageGuid: Map<string, string>;
  storageGuidToPageId: Map<string, string>;
}> {
  const rootRecord = await storage.getDoc(workspaceId, workspaceId);
  const rootYDoc = new Y.Doc({ guid: workspaceId });
  if (rootRecord?.bin) {
    Y.applyUpdate(rootYDoc, rootRecord.bin);
  }

  const pages: WorkspaceDocMetaItem[] = [];
  const metaMap = rootYDoc.getMap('meta');
  const pagesRaw = metaMap?.get('pages');

  if (pagesRaw && typeof (pagesRaw as any).forEach === 'function') {
    (pagesRaw as any).forEach((page: any) => {
      const id = typeof page?.get === 'function' ? page.get('id') : page?.id;
      const title =
        typeof page?.get === 'function' ? page.get('title') : page?.title;
      const trash =
        typeof page?.get === 'function' ? page.get('trash') : page?.trash;
      const createDate =
        typeof page?.get === 'function'
          ? page.get('createDate')
          : page?.createDate;
      const updatedDate =
        typeof page?.get === 'function'
          ? page.get('updatedDate')
          : page?.updatedDate;
      if (id) {
        pages.push({
          id: String(id),
          title:
            typeof title === 'string' && title.trim() ? title : 'Untitled',
          trash: Boolean(trash),
          createDate: typeof createDate === 'number' ? createDate : undefined,
          updatedDate:
            typeof updatedDate === 'number' ? updatedDate : undefined,
        });
      }
    });
  }

  const pageIdToStorageGuid = new Map<string, string>();
  const storageGuidToPageId = new Map<string, string>();

  const spaces = rootYDoc.getMap('spaces');
  if (spaces && typeof (spaces as any).get === 'function') {
    for (const p of pages) {
      const subdoc = (spaces as any).get(p.id);
      if (subdoc && typeof subdoc === 'object' && subdoc.guid) {
        pageIdToStorageGuid.set(p.id, subdoc.guid);
        storageGuidToPageId.set(subdoc.guid, p.id);
      }
    }
  }

  return { rootYDoc, pages, pageIdToStorageGuid, storageGuidToPageId };
}

async function commitFoldersUpdate(
  storage: PgWorkspaceDocStorageAdapter,
  event: EventBus,
  workspaceId: string,
  targetDocId: string,
  ydoc: Y.Doc,
  originalBin: Uint8Array | null,
  userId: string
) {
  const fullUpdate = Y.encodeStateAsUpdate(ydoc);
  const diff = originalBin
    ? Y.diffUpdate(fullUpdate, Y.encodeStateVectorFromUpdate(originalBin))
    : fullUpdate;
  if (!diff || diff.length === 0) return;

  const timestamp = await storage.pushDocUpdates(
    workspaceId,
    targetDocId,
    [diff],
    userId
  );
  event.emit('doc.updates.pushed', {
    spaceType: 'workspace',
    spaceId: workspaceId,
    docId: targetDocId,
    updates: [diff],
    timestamp,
    editor: userId,
  });
}

function linkDocToFolderInYDoc(
  ydoc: Y.Doc,
  docId: string,
  targetFolderId: string | null
) {
  let existingKey: string | null = null;
  for (const [key, map] of ydoc.share.entries()) {
    if (map && typeof (map as any).get === 'function') {
      if ((map as any).get('$$DELETED')) continue;
      if (
        (map as any).get('type') === 'doc' &&
        (map as any).get('data') === docId
      ) {
        existingKey = key;
        break;
      }
    }
  }

  if (targetFolderId) {
    const key = existingKey || nanoid();
    const map = ydoc.getMap(key);
    map.set('id', key);
    map.set('parentId', targetFolderId);
    map.set('type', 'doc');
    map.set('data', docId);
    map.set('index', 'a0' + Date.now().toString(36));
    map.delete('$$DELETED');
  } else if (existingKey) {
    const map = ydoc.getMap(existingKey);
    map.set('$$DELETED', true);
  }
}

@Injectable()
export class WorkspaceMcpProvider {
  constructor(
    private readonly ac: PermissionAccess,
    private readonly reader: DocReader,
    private readonly writer: DocWriter,
    private readonly retrieval: DocumentRetrievalService,
    private readonly models: Models,
    private readonly storage: PgWorkspaceDocStorageAdapter,
    private readonly event: EventBus
  ) {}

  async for(
    userId: string,
    workspaceId: string,
    accessMode: McpAccessMode = McpAccessMode.READ_ONLY
  ): Promise<WorkspaceMcpServer> {
    await this.ac.user(userId).workspace(workspaceId).assert('Workspace.Read');

    const readDocument = defineTool({
      name: 'read_document',
      title: 'Read Document',
      description: 'Read a document with given ID',
      parser: z.object({ docId: z.string() }),
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
        },
        required: ['docId'],
        additionalProperties: false,
      },
      execute: async ({ docId }, options) => {
        const notFoundError = toolError(`Doc with id ${docId} not found.`);

        const accessible = await this.ac
          .user(userId)
          .workspace(workspaceId)
          .doc(docId)
          .can('Doc.Read');
        if (!accessible) return notFoundError;

        const abortedAfterPermission = abortIfNeeded(options.signal);
        if (abortedAfterPermission) return abortedAfterPermission;

        let docMarkdown: string | null = null;

        // 1. Try reading directly via reader
        try {
          const content = await this.reader.getDocMarkdown(
            workspaceId,
            docId,
            false
          );
          if (content?.markdown) {
            docMarkdown = content.markdown;
          }
        } catch {
          // ignore
        }

        // 2. Check rootDoc ID mapping if not found
        if (!docMarkdown) {
          try {
            const { pageIdToStorageGuid, storageGuidToPageId } =
              await loadRootDoc(this.storage, workspaceId);
            const alternateId =
              pageIdToStorageGuid.get(docId) ||
              storageGuidToPageId.get(docId);
            if (alternateId && alternateId !== docId) {
              const content = await this.reader.getDocMarkdown(
                workspaceId,
                alternateId,
                false
              );
              if (content?.markdown) {
                docMarkdown = content.markdown;
              }
            }
          } catch {
            // ignore
          }
        }

        // 3. Fallback to direct storage reading & parsing
        if (!docMarkdown) {
          try {
            const docRecord = await this.storage.getDoc(workspaceId, docId);
            if (docRecord?.bin) {
              const res = parseDocToMarkdownFromDocSnapshot(
                workspaceId,
                docId,
                docRecord.bin,
                false
              );
              if (res?.markdown) {
                docMarkdown = res.markdown;
              }
            }
          } catch {
            // ignore
          }
        }

        if (!docMarkdown) return notFoundError;

        const abortedAfterRead = abortIfNeeded(options.signal);
        if (abortedAfterRead) return abortedAfterRead;

        return toolText(docMarkdown);
      },
    });

    const docSearch = defineTool({
      name: 'doc_search',
      title: 'Document Search',
      description:
        'Search persisted workspace documents and return bounded passages with Page or canvas locators. Retrieval strategy is selected by the server and never includes files, blobs, attachments, or the web.',
      parser: z.object({
        query: z.string().trim().min(1).max(2000),
        doc_ids: z.array(z.string().min(1).max(128)).max(50).optional(),
        limit: z.number().int().min(1).max(20).optional(),
      }),
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          doc_ids: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 50,
          },
          limit: { type: 'integer', minimum: 1, maximum: 20 },
        },
        required: ['query'],
        additionalProperties: false,
      },
      execute: async ({ query, doc_ids, limit }, options) => {
        const result = await this.retrieval.search(
          { user: userId, workspace: workspaceId },
          query,
          doc_ids,
          limit ?? 10,
          options.signal
        );
        return toolText(
          JSON.stringify({
            retrieval_mode: result.retrievalMode,
            degraded_reason: result.degradedReason,
            hits: result.hits.map(hit => ({
              doc_id: hit.docId,
              title: hit.title,
              excerpt: hit.excerpt,
              visibility: hit.visibility,
              block_id: hit.blockId,
              element_id: hit.elementId,
              frame_id: hit.frameId,
            })),
          })
        );
      },
    });

    const listFolders = defineTool({
      name: 'list_folders',
      title: 'List Folders',
      description:
        'List all folders and subfolders in the workspace hierarchy, including document counts.',
      parser: z.object({}),
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      execute: async (_args, options) => {
        const aborted = abortIfNeeded(options.signal);
        if (aborted) return aborted;

        try {
          const { ydoc, targetDocId, allDocIds } = await loadFoldersYDoc(
            this.storage,
            this.models,
            workspaceId
          );
          const { folders, docLinks, rawRecords } = parseFoldersYDoc(ydoc);

          const docCountMap = new Map<string, number>();
          for (const link of docLinks) {
            docCountMap.set(
              link.folderId,
              (docCountMap.get(link.folderId) ?? 0) + 1
            );
          }

          type FolderItem = {
            id: string;
            name: string;
            parentId: string | null;
            documentCount: number;
            subfolders: FolderItem[];
          };

          const folderMap = new Map<string, FolderItem>();
          for (const f of folders) {
            folderMap.set(f.id, {
              id: f.id,
              name: f.name,
              parentId: f.parentId,
              documentCount: docCountMap.get(f.id) ?? 0,
              subfolders: [],
            });
          }

          const rootFolders: FolderItem[] = [];
          for (const f of folders) {
            const item = folderMap.get(f.id)!;
            if (f.parentId && folderMap.has(f.parentId)) {
              folderMap.get(f.parentId)!.subfolders.push(item);
            } else {
              rootFolders.push(item);
            }
          }

          const responseObj: Record<string, any> = {
            totalFolders: folders.length,
            totalLinkedDocuments: docLinks.length,
            folders: rootFolders,
          };

          if (folders.length === 0) {
            responseObj.debug = {
              activeFoldersDocId: targetDocId,
              existingFolderAndDbDocIds: allDocIds.filter(
                id =>
                  id.startsWith('db$') ||
                  id.includes('folder') ||
                  id === workspaceId
              ),
              shareKeys: Array.from(ydoc.share.keys()),
              sampleRecords: rawRecords.slice(0, 5),
            };
          }

          return toolText(JSON.stringify(responseObj, null, 2));
        } catch (error) {
          return toolError(
            `Failed to list folders: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      },
    });

    const listDocuments = defineTool({
      name: 'list_documents',
      title: 'List Documents',
      description:
        'List documents in the workspace. Provide folderId to list only documents inside that folder, or "root" for documents not assigned to any folder. Supports pagination.',
      parser: z.object({
        folderId: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      }),
      inputSchema: {
        type: 'object',
        properties: {
          folderId: {
            type: 'string',
            description:
              'Optional folder ID to filter documents. Pass "root" for unassigned documents. Omit to list all documents.',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 100,
            description: 'Number of documents to return (default 50)',
          },
          offset: {
            type: 'integer',
            minimum: 0,
            description: 'Number of documents to skip (default 0)',
          },
        },
        additionalProperties: false,
      },
      execute: async ({ folderId, limit = 50, offset = 0 }, options) => {
        const aborted = abortIfNeeded(options.signal);
        if (aborted) return aborted;

        try {
          const [{ ydoc }, rootInfo] = await Promise.all([
            loadFoldersYDoc(this.storage, this.models, workspaceId),
            loadRootDoc(this.storage, workspaceId),
          ]);
          const { folders, docLinks } = parseFoldersYDoc(ydoc);
          const folderNameMap = new Map(folders.map(f => [f.id, f.name]));

          // Map docId -> { folderId, folderName }
          const docToFolder = new Map<
            string,
            { folderId: string; folderName: string }
          >();
          for (const link of docLinks) {
            const folderName =
              folderNameMap.get(link.folderId) ?? 'Unknown Folder';
            docToFolder.set(link.docId, {
              folderId: link.folderId,
              folderName,
            });
            const altId =
              rootInfo.pageIdToStorageGuid.get(link.docId) ||
              rootInfo.storageGuidToPageId.get(link.docId);
            if (altId) {
              docToFolder.set(altId, {
                folderId: link.folderId,
                folderName,
              });
            }
          }

          // Build master document list from rootDoc pages (excluding trash)
          const allDocs = rootInfo.pages
            .filter(p => !p.trash)
            .map(p => {
              const folderInfo =
                docToFolder.get(p.id) ||
                (rootInfo.pageIdToStorageGuid.has(p.id)
                  ? docToFolder.get(rootInfo.pageIdToStorageGuid.get(p.id)!)
                  : undefined);
              return {
                docId: p.id,
                title: p.title,
                folderId: folderInfo?.folderId ?? null,
                folderName: folderInfo?.folderName ?? null,
                createdAt: p.createDate
                  ? new Date(p.createDate).toISOString()
                  : null,
                updatedAt: p.updatedDate
                  ? new Date(p.updatedDate).toISOString()
                  : null,
              };
            });

          // Filter by folderId
          let filtered = allDocs;
          if (folderId && folderId !== 'all') {
            if (folderId === 'root') {
              filtered = allDocs.filter(d => !d.folderId);
            } else {
              filtered = allDocs.filter(d => d.folderId === folderId);
            }
          }

          const paged = filtered.slice(offset, offset + limit);

          return toolText(
            JSON.stringify(
              {
                total: filtered.length,
                totalAllDocuments: allDocs.length,
                offset,
                limit,
                filter: folderId ?? 'all',
                documents: paged,
              },
              null,
              2
            )
          );
        } catch (error) {
          return toolError(
            `Failed to list documents: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      },
    });

    const tools = [readDocument, docSearch, listFolders, listDocuments];

    const createFolder = defineTool({
        name: 'create_folder',
        title: 'Create Folder',
        description:
          'Create a new folder in the workspace, optionally inside a parent folder.',
        parser: z.object({
          name: z.string().trim().min(1),
          parentFolderId: z.string().optional(),
        }),
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'The name of the new folder',
            },
            parentFolderId: {
              type: 'string',
              description:
                'Optional parent folder ID to nest this folder inside another folder',
            },
          },
          required: ['name'],
          additionalProperties: false,
        },
        execute: async ({ name, parentFolderId }, options) => {
          try {
            await this.ac
              .user(userId)
              .workspace(workspaceId)
              .assert('Workspace.CreateDoc');

            const aborted = abortIfNeeded(options.signal);
            if (aborted) return aborted;

            const { ydoc, bin, targetDocId } = await loadFoldersYDoc(
              this.storage,
              this.models,
              workspaceId
            );

            if (parentFolderId) {
              const { folders } = parseFoldersYDoc(ydoc);
              const parentExists = folders.some(f => f.id === parentFolderId);
              if (!parentExists) {
                return toolError(
                  `Parent folder with id "${parentFolderId}" not found.`
                );
              }
            }

            const folderId = nanoid();
            const record = ydoc.getMap(folderId);
            record.set('id', folderId);
            record.set('parentId', parentFolderId ?? null);
            record.set('type', 'folder');
            record.set('data', name);
            record.set('index', 'a0' + Date.now().toString(36));
            record.delete('$$DELETED');

            await commitFoldersUpdate(
              this.storage,
              this.event,
              workspaceId,
              targetDocId,
              ydoc,
              bin,
              userId
            );

            return toolText(
              JSON.stringify({
                success: true,
                folderId,
                name,
                parentId: parentFolderId ?? null,
                message: `Folder "${name}" created successfully`,
              })
            );
          } catch (error) {
            return toolError(
              `Failed to create folder: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
          }
        },
      });

      const moveDocument = defineTool({
        name: 'move_document',
        title: 'Move Document to Folder',
        description:
          'Move or assign a document into a folder, or pass null/empty folderId to move it to root (unorganized).',
        parser: z.object({
          docId: z.string(),
          targetFolderId: z.string().nullable().optional(),
        }),
        inputSchema: {
          type: 'object',
          properties: {
            docId: {
              type: 'string',
              description: 'The ID of the document to move',
            },
            targetFolderId: {
              type: 'string',
              description:
                'The ID of the target folder, or null to move document to root',
            },
          },
          required: ['docId'],
          additionalProperties: false,
        },
        execute: async ({ docId, targetFolderId }, options) => {
          try {
            await this.ac
              .user(userId)
              .workspace(workspaceId)
              .doc(docId)
              .assert('Doc.Update');

            const aborted = abortIfNeeded(options.signal);
            if (aborted) return aborted;

            const { ydoc, bin, targetDocId } = await loadFoldersYDoc(
              this.storage,
              this.models,
              workspaceId
            );

            if (targetFolderId) {
              const { folders } = parseFoldersYDoc(ydoc);
              const parentExists = folders.some(f => f.id === targetFolderId);
              if (!parentExists) {
                return toolError(
                  `Target folder with id "${targetFolderId}" not found.`
                );
              }
            }

            linkDocToFolderInYDoc(ydoc, docId, targetFolderId || null);

            await commitFoldersUpdate(
              this.storage,
              this.event,
              workspaceId,
              targetDocId,
              ydoc,
              bin,
              userId
            );

            return toolText(
              JSON.stringify({
                success: true,
                docId,
                targetFolderId: targetFolderId || null,
                message: targetFolderId
                  ? `Document moved to folder "${targetFolderId}"`
                  : 'Document moved to root',
              })
            );
          } catch (error) {
            return toolError(
              `Failed to move document: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
          }
        },
      });

      const createDocument = defineTool({
        name: 'create_document',
        title: 'Create Document',
        description:
          'Create a new document in the workspace with title and markdown content, optionally inside a folder. Returns the ID of the created document.',
        parser: z.object({
          title: z.string().min(1),
          content: z.string(),
          folderId: z.string().optional(),
        }),
        inputSchema: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
              description: 'The title of the new document',
            },
            content: {
              type: 'string',
              description: 'The markdown content for the document body',
            },
            folderId: {
              type: 'string',
              description:
                'Optional folder ID to place the new document into',
            },
          },
          required: ['title', 'content'],
          additionalProperties: false,
        },
        execute: async ({ title, content, folderId }, options) => {
          try {
            await this.ac
              .user(userId)
              .workspace(workspaceId)
              .assert('Workspace.CreateDoc');

            const abortedAfterPermission = abortIfNeeded(options.signal);
            if (abortedAfterPermission) return abortedAfterPermission;

            const sanitizedTitle = title.replace(/[\r\n]+/g, ' ').trim();
            if (!sanitizedTitle) throw new Error('Title cannot be empty');
            const strippedContent = content.replace(
              /^[ \t]{0,3}#\s+[^\n]*#*\s*\n*/,
              ''
            );
            const result = await this.writer.createDoc(
              workspaceId,
              sanitizedTitle,
              strippedContent,
              userId
            );

            if (folderId) {
              const { ydoc, bin, targetDocId } = await loadFoldersYDoc(
                this.storage,
                this.models,
                workspaceId
              );
              linkDocToFolderInYDoc(ydoc, result.docId, folderId);
              await commitFoldersUpdate(
                this.storage,
                this.event,
                workspaceId,
                targetDocId,
                ydoc,
                bin,
                userId
              );
            }

            return toolText(
              JSON.stringify({
                success: true,
                docId: result.docId,
                folderId: folderId ?? null,
                message: `Document "${title}" created successfully${folderId ? ` in folder "${folderId}"` : ''}`,
              })
            );
          } catch (error) {
            return toolError(
              `Failed to create document: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
          }
        },
      });

      const updateDocument = defineTool({
        name: 'update_document',
        title: 'Update Document',
        description:
          'Update an existing document with new markdown content (body only). Uses structural diffing to apply minimal changes, preserving document history and enabling real-time collaboration. This does NOT update the document title.',
        parser: z.object({
          docId: z.string(),
          content: z.string(),
        }),
        inputSchema: {
          type: 'object',
          properties: {
            docId: {
              type: 'string',
              description: 'The ID of the document to update',
            },
            content: {
              type: 'string',
              description:
                'The complete new markdown content for the document body (do NOT include a title H1)',
            },
          },
          required: ['docId', 'content'],
          additionalProperties: false,
        },
        execute: async ({ docId, content }, options) => {
          const notFoundError = toolError(`Doc with id ${docId} not found.`);

          const accessible = await this.ac
            .user(userId)
            .workspace(workspaceId)
            .doc(docId)
            .can('Doc.Update');
          if (!accessible) return notFoundError;

          const abortedBeforeWrite = abortIfNeeded(options.signal);
          if (abortedBeforeWrite) return abortedBeforeWrite;

          try {
            await this.writer.updateDoc(workspaceId, docId, content, userId);
            return toolText(
              JSON.stringify({
                success: true,
                docId,
                message: 'Document updated successfully',
              })
            );
          } catch (error) {
            return toolError(
              `Failed to update document: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
          }
        },
      });

      const updateDocumentMeta = defineTool({
        name: 'update_document_meta',
        title: 'Update Document Metadata',
        description: 'Update document metadata (currently title only).',
        parser: z.object({
          docId: z.string(),
          title: z.string().min(1),
        }),
        inputSchema: {
          type: 'object',
          properties: {
            docId: {
              type: 'string',
              description: 'The ID of the document to update',
            },
            title: {
              type: 'string',
              description: 'The new document title',
            },
          },
          required: ['docId', 'title'],
          additionalProperties: false,
        },
        execute: async ({ docId, title }, options) => {
          const notFoundError = toolError(`Doc with id ${docId} not found.`);

          const accessible = await this.ac
            .user(userId)
            .workspace(workspaceId)
            .doc(docId)
            .can('Doc.Update');
          if (!accessible) return notFoundError;

          const abortedAfterPermission = abortIfNeeded(options.signal);
          if (abortedAfterPermission) return abortedAfterPermission;

          try {
            const sanitizedTitle = title.replace(/[\r\n]+/g, ' ').trim();
            if (!sanitizedTitle) throw new Error('Title cannot be empty');

            await this.writer.updateDocMeta(
              workspaceId,
              docId,
              { title: sanitizedTitle },
              userId
            );

            return toolText(
              JSON.stringify({
                success: true,
                docId,
                message: 'Document title updated successfully',
              })
            );
          } catch (error) {
            return toolError(
              `Failed to update document metadata: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
          }
        },
      });

    tools.push(
      createDocument,
      updateDocument,
      updateDocumentMeta,
      createFolder,
      moveDocument
    );

    return {
      name: `AFFiNE MCP Server for Workspace ${workspaceId}`,
      version: '1.0.1',
      tools,
    };
  }
}
