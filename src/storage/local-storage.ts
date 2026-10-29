import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { IArtifactStorage, ArtifactMetadata, PutArtifactOptions } from './artifact-storage.js';

export interface LocalStorageOptions {
  baseDirectory?: string;
  maxSizeBytes?: number;
}

const META_SUFFIX = '.meta.json';

export class LocalStorageProvider implements IArtifactStorage {
  public readonly providerName = 'local';
  private baseDirectory: string;
  private maxSizeBytes: number;
  private metadataRegistry = new Map<string, ArtifactMetadata>();
  private hasExplicitDirectory: boolean;

  constructor(options?: LocalStorageOptions) {
    this.hasExplicitDirectory = Boolean(options?.baseDirectory);
    this.baseDirectory = path.resolve(
      process.cwd(),
      options?.baseDirectory || process.env.ARTIFACT_STORAGE_DIR || 'storage/artifacts'
    );
    this.maxSizeBytes = options?.maxSizeBytes || 25 * 1024 * 1024; // 25MB limit
    this.ensureBaseDirectory();
  }

  private ensureBaseDirectory(): void {
    try {
      if (!fs.existsSync(this.baseDirectory)) {
        fs.mkdirSync(this.baseDirectory, { recursive: true });
      }
      fs.accessSync(this.baseDirectory, fs.constants.W_OK);
    } catch {
      if (!this.hasExplicitDirectory) {
        try {
          this.baseDirectory = path.resolve(os.tmpdir(), 'fortix-artifacts');
          if (!fs.existsSync(this.baseDirectory)) {
            fs.mkdirSync(this.baseDirectory, { recursive: true });
          }
        } catch {
          // Handled in restricted environments
        }
      }
    }
  }

  private sanitizeFilename(filename: string): string {
    const cleaned = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    return cleaned || 'artifact.pdf';
  }

  private sanitizeSegment(segment: string): string {
    const cleaned = String(segment || '').trim();
    if (!cleaned || cleaned.includes('..') || cleaned.includes('/') || cleaned.includes('\\')) {
      throw new Error(`Path traversal attempt blocked: ${segment}`);
    }
    return cleaned;
  }

  private getSafePath(objectKey: string): string {
    if (objectKey.includes('..') || objectKey.startsWith('/') || objectKey.startsWith('\\')) {
      const resolved = path.resolve(this.baseDirectory, objectKey);
      if (!resolved.startsWith(this.baseDirectory + path.sep) && resolved !== this.baseDirectory) {
        throw new Error(`Path traversal attempt blocked: ${objectKey}`);
      }
    }
    const resolvedPath = path.resolve(this.baseDirectory, objectKey);

    if (!resolvedPath.startsWith(this.baseDirectory + path.sep) && resolvedPath !== this.baseDirectory) {
      throw new Error(`Path traversal attempt blocked: ${objectKey}`);
    }

    return resolvedPath;
  }

  private cacheMetadata(metadata: ArtifactMetadata): void {
    this.metadataRegistry.set(metadata.artifactId, metadata);
    this.metadataRegistry.set(metadata.objectKey, metadata);
  }

  private async loadProjectArtifactsFromDisk(projectId: string): Promise<ArtifactMetadata[]> {
    const safeProjectId = this.sanitizeSegment(projectId);
    const projectDir = this.getSafePath(safeProjectId);
    if (!fs.existsSync(projectDir)) return [];

    const loaded: ArtifactMetadata[] = [];
    let entries: string[] = [];
    try {
      entries = await fs.promises.readdir(projectDir);
    } catch {
      return [];
    }

    const metaFiles = new Set(entries.filter((f) => f.endsWith(META_SUFFIX)));

    // 1. Read persisted .meta.json sidecar files first
    for (const metaFile of metaFiles) {
      try {
        const rawJson = await fs.promises.readFile(path.join(projectDir, metaFile), 'utf8');
        const parsed = JSON.parse(rawJson) as ArtifactMetadata;
        if (parsed && parsed.artifactId && parsed.objectKey && parsed.projectId === safeProjectId) {
          const artifactPath = this.getSafePath(parsed.objectKey);
          if (fs.existsSync(artifactPath)) {
            this.cacheMetadata(parsed);
            loaded.push(parsed);
          }
        }
      } catch {
        // Ignore corrupted sidecar file
      }
    }

    // 2. Reconstruct any raw artifact files lacking a sidecar file
    for (const entry of entries) {
      if (entry.endsWith(META_SUFFIX)) continue;
      if (metaFiles.has(`${entry}${META_SUFFIX}`)) continue;

      const objectKey = `${safeProjectId}/${entry}`;
      if (this.metadataRegistry.has(objectKey)) {
        loaded.push(this.metadataRegistry.get(objectKey)!);
        continue;
      }

      try {
        const fullPath = path.join(projectDir, entry);
        const stats = await fs.promises.stat(fullPath);
        if (!stats.isFile()) continue;
        const data = await fs.promises.readFile(fullPath);
        const sha256 = crypto.createHash('sha256').update(data).digest('hex');
        const dashIdx = entry.indexOf('-');
        const artifactId = dashIdx > 0 ? entry.slice(0, dashIdx) : entry;
        const filename = dashIdx > 0 ? entry.slice(dashIdx + 1) : entry;

        const reconstructed: ArtifactMetadata = {
          artifactId,
          projectId: safeProjectId,
          storageProvider: 'local',
          objectKey,
          contentType: 'application/pdf',
          sizeBytes: stats.size,
          sha256,
          filename,
          createdAt: stats.birthtime.toISOString(),
        };
        this.cacheMetadata(reconstructed);
        loaded.push(reconstructed);
      } catch {}
    }

    return loaded;
  }

  public async put(buffer: Buffer | Uint8Array, options: PutArtifactOptions): Promise<ArtifactMetadata> {
    if (!options.projectId) {
      throw new Error('projectId is required for artifact storage.');
    }
    const safeProjectId = this.sanitizeSegment(options.projectId);

    const nodeBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    if (nodeBuffer.length > this.maxSizeBytes) {
      throw new Error(`Artifact size (${nodeBuffer.length} bytes) exceeds limit of ${this.maxSizeBytes} bytes.`);
    }

    const artifactId = options.artifactId ? this.sanitizeSegment(options.artifactId) : uuidv4();
    const sanitizedName = this.sanitizeFilename(options.filename);
    const objectKey = `${safeProjectId}/${artifactId}-${sanitizedName}`;
    const filePath = this.getSafePath(objectKey);

    const sha256 = crypto.createHash('sha256').update(nodeBuffer).digest('hex');

    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    await fs.promises.writeFile(filePath, nodeBuffer);

    const metadata: ArtifactMetadata = {
      artifactId,
      verificationId: options.verificationId,
      projectId: safeProjectId,
      storageProvider: 'local',
      objectKey,
      contentType: options.contentType || 'application/pdf',
      sizeBytes: nodeBuffer.length,
      sha256,
      filename: sanitizedName,
      createdAt: new Date().toISOString(),
      customMetadata: options.customMetadata,
    };

    // Persist durable sidecar metadata so artifacts survive server restarts
    try {
      await fs.promises.writeFile(`${filePath}${META_SUFFIX}`, JSON.stringify(metadata, null, 2), 'utf8');
    } catch {
      // In-memory registry still serves current process
    }

    this.cacheMetadata(metadata);

    return metadata;
  }

  public async get(
    objectKeyOrId: string,
    projectId?: string
  ): Promise<{ data: Buffer; metadata: ArtifactMetadata } | null> {
    const metadata = await this.getMetadata(objectKeyOrId, projectId);
    if (!metadata) return null;

    if (projectId && metadata.projectId !== projectId) {
      throw new Error(`Access Denied: Artifact does not belong to project ${projectId}`);
    }

    try {
      const filePath = this.getSafePath(metadata.objectKey);
      if (!fs.existsSync(filePath)) return null;

      const data = await fs.promises.readFile(filePath);

      const currentHash = crypto.createHash('sha256').update(data).digest('hex');
      if (currentHash !== metadata.sha256) {
        throw new Error(`Data integrity violation: SHA-256 mismatch for artifact ${metadata.artifactId}`);
      }

      return { data, metadata };
    } catch (err) {
      if ((err as any).message?.includes('Access Denied') || (err as any).message?.includes('Data integrity violation')) {
        throw err;
      }
      return null;
    }
  }

  public async getMetadata(objectKeyOrId: string, projectId?: string): Promise<ArtifactMetadata | null> {
    this.getSafePath(objectKeyOrId);

    let metadata = this.metadataRegistry.get(objectKeyOrId);

    if (!metadata) {
      // 1. Direct objectKey lookup (with sidecar metadata support)
      try {
        const filePath = this.getSafePath(objectKeyOrId);
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const sidecarPath = `${filePath}${META_SUFFIX}`;
          if (fs.existsSync(sidecarPath)) {
            const parsed = JSON.parse(await fs.promises.readFile(sidecarPath, 'utf8')) as ArtifactMetadata;
            metadata = parsed;
            this.cacheMetadata(parsed);
          } else {
            const stats = await fs.promises.stat(filePath);
            const data = await fs.promises.readFile(filePath);
            const sha256 = crypto.createHash('sha256').update(data).digest('hex');
            const inferredProjectId = objectKeyOrId.includes('/') ? objectKeyOrId.split('/')[0] : projectId || 'unknown';
            const base = path.basename(filePath);
            const dashIdx = base.indexOf('-');
            metadata = {
              artifactId: dashIdx > 0 ? base.slice(0, dashIdx) : uuidv4(),
              projectId: inferredProjectId,
              storageProvider: 'local',
              objectKey: objectKeyOrId,
              contentType: 'application/pdf',
              sizeBytes: stats.size,
              sha256,
              filename: dashIdx > 0 ? base.slice(dashIdx + 1) : base,
              createdAt: stats.birthtime.toISOString(),
            };
            this.cacheMetadata(metadata);
          }
        }
      } catch {
        return null;
      }

      // 2. Post-restart lookup by artifactId within projectId directory
      if (!metadata && !objectKeyOrId.includes('/') && projectId) {
        await this.loadProjectArtifactsFromDisk(projectId);
        metadata = this.metadataRegistry.get(objectKeyOrId);
      }
    }

    if (!metadata) return null;

    if (projectId && metadata.projectId !== projectId) {
      throw new Error(`Access Denied: Artifact does not belong to project ${projectId}`);
    }

    return metadata;
  }

  public async exists(objectKeyOrId: string, projectId?: string): Promise<boolean> {
    try {
      const meta = await this.getMetadata(objectKeyOrId, projectId);
      return meta !== null;
    } catch {
      return false;
    }
  }

  public async delete(objectKeyOrId: string, projectId?: string): Promise<boolean> {
    const metadata = await this.getMetadata(objectKeyOrId, projectId);
    if (!metadata) return false;

    if (projectId && metadata.projectId !== projectId) {
      throw new Error(`Access Denied: Artifact does not belong to project ${projectId}`);
    }

    try {
      const filePath = this.getSafePath(metadata.objectKey);
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
      }
      const sidecarPath = `${filePath}${META_SUFFIX}`;
      if (fs.existsSync(sidecarPath)) {
        await fs.promises.unlink(sidecarPath);
      }
      this.metadataRegistry.delete(metadata.artifactId);
      this.metadataRegistry.delete(metadata.objectKey);
      return true;
    } catch {
      return false;
    }
  }

  public async listByProject(projectId: string, limit: number = 50): Promise<ArtifactMetadata[]> {
    // Hydrate any post-restart artifacts on disk for this project before listing
    await this.loadProjectArtifactsFromDisk(projectId);

    const results: ArtifactMetadata[] = [];
    const seen = new Set<string>();

    for (const meta of this.metadataRegistry.values()) {
      if (meta.projectId === projectId && !seen.has(meta.artifactId)) {
        seen.add(meta.artifactId);
        results.push(meta);
      }
    }

    return results
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);
  }
}
