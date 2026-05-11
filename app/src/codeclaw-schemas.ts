import { z } from 'zod'

/** JSON shape after `extractJson` + `JSON.parse` for CodeClaw fix proposals (before per-file diff normalization). */
export const PatchProposalInputSchema = z.object({
  summary: z
    .string({ required_error: 'summary is required' })
    .refine(s => s.trim().length > 0, { message: 'summary must be a non-empty string' }),
  rootCause: z
    .string({ required_error: 'rootCause is required' })
    .refine(s => s.trim().length > 0, { message: 'rootCause must be a non-empty string' }),
  verifyTask: z.string().optional(),
  verifyCommand: z.string().optional(),
  /** Non-string values were previously ignored (`medium`); coerce primitives so Zod does not reject odd models. */
  risk: z
    .union([z.string(), z.number(), z.boolean(), z.null()])
    .optional()
    .transform(v => (v === null || v === undefined ? undefined : String(v))),
  notes: z
    .union([z.array(z.string()), z.null()])
    .optional()
    .transform(v => (v === null ? undefined : v)),
  files: z.array(z.unknown()).min(1, { message: 'files must be a non-empty array' }),
})

export type PatchProposalInput = z.infer<typeof PatchProposalInputSchema>

/**
 * Top-level JSON for CodeClaw review (after parse). Findings entries remain loose objects;
 * downstream maps severities and defaults like today.
 */
export const ReviewProposalInputSchema = z.object({
  summary: z.string().optional(),
  safeToCommit: z.boolean().optional(),
  findings: z
    .union([z.array(z.record(z.unknown())), z.null()])
    .optional()
    .transform(v => (v === null ? undefined : v)),
})

export type ReviewProposalInput = z.infer<typeof ReviewProposalInputSchema>

export function formatPatchProposalZodError(error: z.ZodError): string {
  return error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
}
