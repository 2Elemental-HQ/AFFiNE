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

async function loadFoldersYDoc(
  storage: PgWorkspaceDocStorageAdapter,
  workspaceId: string
): Promise<{ ydoc: Y.Doc; bin: Uint8Array | null }> {
  const docRecord = await storage.getDoc(workspaceId, 'db$folders');
  const ydoc = new Y.Doc();
  if (docRecord?.bin) {
    Y.applyUpdate(ydoc, docRecord.bin);
  }
  return { ydoc, bin: docRecord?.bin ?? null };
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

  for (const [key, map] of ydoc.share.entries()) {
    if (map instanceof Y.Map) {
      if (map.get('$$DELETED')) continue;
      const id = (map.get('id') as string) || key;
      const parentId = (map.get('parentId') as string) || null;
      const type = map.get('type') as string;
      const data = map.get('data') as string;
      const index = (map.get('index') as string) || '';

      if (type === 'folder' && data) {
        folders.push({ id, name: data, parentId, index });
      } else if (type === 'doc' && data && parentId) {
        docLinks.push({ id, docId: data, folderId: parentId, index });
      }
    }
  }
  return { folders, docLinks };
}

async function commitFoldersUpdate(
  storage: PgWorkspaceDocStorageAdapter,
  event: EventBus,
  workspaceId: string,
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
    'db$folders',
    [diff],
    userId
  );
  event.emit('doc.updates.pushed', {
    spaceType: 'workspace',
    spaceId: workspaceId,
    docId: 'db$folders',
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
    if (map instanceof Y.Map && !map.get('$$DELETED')) {
      if (map.get('type') === 'doc' && map.get('data') === docId) {
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

        const content = await this.reader.getDocMarkdown(
          workspaceId,
          docId,
          false
        );
        if (!content) return notFoundError;

        const abortedAfterRead = abortIfNeeded(options.signal);
        if (abortedAfterRead) return abortedAfterRead;

        return toolText(content.markdown);
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
          const { ydoc } = await loadFoldersYDoc(this.storage, workspaceId);
          const { folders, docLinks } = parseFoldersYDoc(ydoc);

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

          return toolText(
            JSON.stringify(
              {
                totalFolders: folders.length,
                totalLinkedDocuments: docLinks.length,
                folders: rootFolders,
              },
              null,
              2
            )
          );
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
          const { ydoc } = await loadFoldersYDoc(this.storage, workspaceId);
          const { folders, docLinks } = parseFoldersYDoc(ydoc);
          const folderMap = new Map(folders.map(f => [f.id, f.name]));

          // Filter by specific folder
          if (folderId && folderId !== 'root' && folderId !== 'all') {
            const folderName = folderMap.get(folderId);
            if (!folderName) {
              return toolError(`Folder with id "${folderId}" not found.`);
            }

            const targetLinks = docLinks.filter(l => l.folderId === folderId);
            const pagedLinks = targetLinks.slice(offset, offset + limit);
            const docIds = pagedLinks.map(l => l.docId);

            const metas = await this.models.doc.findMetas(
              docIds.map(docId => ({ workspaceId, docId })),
              { select: { title: true, createdAt: true, updatedAt: true } }
            );
            const metaMap = new Map(
              metas
                .filter((m): m is NonNullable<typeof m> => m !== null)
                .map(m => [m.docId, m])
            );

            const documents = docIds.map(id => {
              const meta = metaMap.get(id);
              return {
                docId: id,
                title: meta?.title ?? 'Untitled',
                folderId,
                folderName,
                createdAt: meta?.createdAt,
                updatedAt: meta?.updatedAt,
              };
            });

            return toolText(
              JSON.stringify(
                {
                  folderId,
                  folderName,
                  totalInFolder: targetLinks.length,
                  offset,
                  limit,
                  documents,
                },
                null,
                2
              )
            );
          }

          // Documents not in any folder ("root")
          if (folderId === 'root') {
            const assignedDocIds = new Set(docLinks.map(l => l.docId));
            const allDocs = await this.models.doc.paginateDocInfo(workspaceId, {
              skip: 0,
              take: 1000,
            });
            const unorganized = allDocs.filter(
              d => !assignedDocIds.has(d.docId)
            );
            const paged = unorganized.slice(offset, offset + limit);

            return toolText(
              JSON.stringify(
                {
                  folderId: 'root',
                  totalInRoot: unorganized.length,
                  offset,
                  limit,
                  documents: paged.map(d => ({
                    docId: d.docId,
                    title: d.title ?? 'Untitled',
                    createdAt: d.createdAt,
                    updatedAt: d.updatedAt,
                  })),
                },
                null,
                2
              )
            );
          }

          // All documents with folder annotations
          const allDocs = await this.models.doc.paginateDocInfo(workspaceId, {
            skip: offset,
            take: limit,
          });

          const docToFolder = new Map<
            string,
            { folderId: string; folderName: string }
          >();
          for (const l of docLinks) {
            const name = folderMap.get(l.folderId);
            if (name) {
              docToFolder.set(l.docId, {
                folderId: l.folderId,
                folderName: name,
              });
            }
          }

          const documents = allDocs.map(d => {
            const folder = docToFolder.get(d.docId);
            return {
              docId: d.docId,
              title: d.title ?? 'Untitled',
              folderId: folder?.folderId ?? null,
              folderName: folder?.folderName ?? null,
              createdAt: d.createdAt,
              updatedAt: d.updatedAt,
            };
          });

          return toolText(
            JSON.stringify(
              {
                offset,
                limit,
                returned: documents.length,
                documents,
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

            const { ydoc, bin } = await loadFoldersYDoc(
              this.storage,
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

            const { ydoc, bin } = await loadFoldersYDoc(
              this.storage,
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
              const { ydoc, bin } = await loadFoldersYDoc(
                this.storage,
                workspaceId
              );
              linkDocToFolderInYDoc(ydoc, result.docId, folderId);
              await commitFoldersUpdate(
                this.storage,
                this.event,
                workspaceId,
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
