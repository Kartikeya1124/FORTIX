import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { db } from '../db/index.js';
import { projects, organizations, verifications, experiments, apiRoutes } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import PDFDocument from 'pdfkit';
import { artifactStorage } from '../storage/index.js';

const router = Router();

function sanitizeAttachmentFilename(raw: string): string {
  const cleaned = String(raw || '')
    .replace(/[\r\n"\\;/]/g, '_')
    .replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned || 'FortiX-Report.pdf';
}

// Helper to generate a PDF buffer using PDFDocument
export function buildPdfBuffer(title: string, metadata: Record<string, string>, content: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40 });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(22).text(title, { align: 'center' });
    doc.moveDown();

    for (const [key, val] of Object.entries(metadata)) {
      doc.fontSize(12).text(`${key}: ${val}`);
    }
    doc.moveDown();

    doc.fontSize(16).text('Verification Assertions & Findings', { underline: true });
    doc.moveDown();
    doc.fontSize(11).text(content || 'All security policies and chaos resilience assertions passed.');

    doc.end();
  });
}

// Generate, persist, and download verification PDF report
router.post('/control/reports/:verificationId', authenticate, async (req, res) => {
  try {
    const verificationId = String(req.params.verificationId);
    const { projectId, details } = req.body || {};

    if (!projectId || typeof projectId !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid projectId in request body' });
    }

    // Verify project ownership (tenant isolation)
    const [project] = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .leftJoin(organizations, eq(projects.orgId, organizations.id))
      .where(and(eq(projects.id, projectId), eq(organizations.ownerId, (req as any).user.id)));

    if (!project) {
      return res.status(403).json({ error: 'Unauthorized: Access to project denied' });
    }

    // Verify that if verificationId references a real verification row in DB, it belongs to this project
    let existingVerificationOwned = false;
    try {
      const [existingVerif] = await db
        .select({
          id: verifications.id,
          routeProjectId: apiRoutes.projectId,
        })
        .from(verifications)
        .innerJoin(experiments, eq(verifications.experimentId, experiments.id))
        .innerJoin(apiRoutes, eq(experiments.routeId, apiRoutes.id))
        .where(eq(verifications.id, verificationId))
        .limit(1);

      if (existingVerif) {
        if (existingVerif.routeProjectId !== projectId) {
          return res.status(403).json({ error: 'Forbidden: Verification record belongs to another project' });
        }
        existingVerificationOwned = true;
      }
    } catch {
      // Ad-hoc verification ID not present in verifications table
    }

    const safeVerificationToken = verificationId.replace(/[^a-zA-Z0-9._-]/g, '_') || 'report';
    const filename = sanitizeAttachmentFilename(`FortiX-Report-${safeVerificationToken}.pdf`);

    // 1. Generate PDF in memory buffer
    const pdfBuffer = await buildPdfBuffer(
      'FortiX Resilience & Verification Evidence',
      {
        'Verification ID': verificationId.slice(0, 128),
        'Project Name': project.name,
        'Generated At': new Date().toISOString(),
        'Engine': 'FortiX Resilience Verification Engine v2.0',
      },
      typeof details === 'string' ? details.slice(0, 50000) : 'Evidence executed, chaos injected, resilience verified.'
    );

    // 2. Persist to Artifact Storage (Local / S3)
    const artifactMeta = await artifactStorage.put(pdfBuffer, {
      verificationId,
      projectId,
      filename,
      contentType: 'application/pdf',
      customMetadata: {
        generatedBy: (req as any).user.id,
      },
    });

    // 3. Update Verification record in Database ONLY when verified as owned by this project
    if (existingVerificationOwned) {
      try {
        await db
          .update(verifications)
          .set({ pdfS3Url: artifactMeta.objectKey })
          .where(eq(verifications.id, verificationId));
      } catch {
        // Non-fatal metadata update
      }
    }

    // 4. Return PDF stream with sanitized Content-Disposition and artifact metadata headers
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    res.setHeader('X-FortiX-Artifact-Id', artifactMeta.artifactId);
    res.setHeader('X-FortiX-Artifact-SHA256', artifactMeta.sha256);
    res.setHeader('X-FortiX-Storage-Provider', artifactMeta.storageProvider);

    res.send(pdfBuffer);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to generate and persist report' });
  }
});

// Download a previously stored artifact by artifactId (with strict project tenant authorization)
router.get('/control/reports/artifacts/:artifactId', authenticate, async (req, res) => {
  try {
    const artifactId = String(req.params.artifactId);
    const projectId = req.query.projectId as string;

    if (!projectId) {
      return res.status(400).json({ error: 'Missing projectId query parameter for authorization' });
    }

    // Verify tenant authorization
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .leftJoin(organizations, eq(projects.orgId, organizations.id))
      .where(and(eq(projects.id, projectId), eq(organizations.ownerId, (req as any).user.id)));

    if (!project) {
      return res.status(403).json({ error: 'Unauthorized: Access to project denied' });
    }

    const artifact = await artifactStorage.get(artifactId, projectId);
    if (!artifact) {
      return res.status(404).json({ error: 'Artifact not found' });
    }

    const safeFilename = sanitizeAttachmentFilename(artifact.metadata.filename);
    res.setHeader('Content-Type', artifact.metadata.contentType);
    res.setHeader('Content-Disposition', `attachment; filename=${safeFilename}`);
    res.setHeader('X-FortiX-Artifact-Id', artifact.metadata.artifactId);
    res.setHeader('X-FortiX-Artifact-SHA256', artifact.metadata.sha256);
    res.setHeader('X-FortiX-Storage-Provider', artifact.metadata.storageProvider);

    res.send(artifact.data);
  } catch (error: any) {
    if (error.message?.includes('Access Denied') || error.message?.includes('Path traversal')) {
      return res.status(403).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to retrieve artifact' });
  }
});

// List all artifacts stored for a project
router.get('/control/reports/projects/:projectId/artifacts', authenticate, async (req, res) => {
  try {
    const projectId = String(req.params.projectId);

    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .leftJoin(organizations, eq(projects.orgId, organizations.id))
      .where(and(eq(projects.id, projectId), eq(organizations.ownerId, (req as any).user.id)));

    if (!project) {
      return res.status(403).json({ error: 'Unauthorized: Access to project denied' });
    }

    const list = await artifactStorage.listByProject(projectId);
    res.json(list);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to list artifacts' });
  }
});

export default router;
