/**
 * Open Knowledge Format (OKF) v0.2 types.
 * Spec: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
 *
 * The spec is deliberately minimal: `type` is the ONLY always-required field,
 * and consumers MUST NOT reject documents for unrecognized keys (§11). The
 * interfaces below therefore describe the fields we *understand*, not the
 * fields we *allow* — everything else rides along in the index signature.
 */

export const OKF_VERSION = "0.2";

/**
 * Actor convention (§7):
 *  - agents/tools:      `<producer>/<version>`  e.g. "project-brain/0.15.0"
 *  - people:            `human:<id>`            e.g. "human:jcsoftdev"
 *  - automated process: `process:<id>`          e.g. "process:nightly-sync"
 *
 * Consumers classify trust by detecting the `human:` prefix.
 */
export type OkfActor = string;

/** Provenance entry (§5.1). Only `resource` is required per entry. */
export interface OkfSource {
  id?: string;
  resource: string;
  title?: string;
  author?: OkfActor;
  usage_count?: number;
  last_modified?: string;
  [key: string]: unknown;
}

/** Trust attestation (§5.2). */
export interface OkfAttestation {
  by: OkfActor;
  at: string;
  [key: string]: unknown;
}

/** Lifecycle status (§5.4). `stable` is the spec default. */
export type OkfStatus = "draft" | "stable" | "deprecated";

export interface OkfFrontmatter {
  /** The only always-required field (§4). */
  type?: string;
  title?: string;
  description?: string;
  resource?: string;
  tags?: string[];
  status?: OkfStatus;
  stale_after?: string;
  sources?: OkfSource[];
  generated?: OkfAttestation;
  verified?: OkfAttestation[];
  /** Bundle-root index.md only (§12). */
  okf_version?: string;
  [key: string]: unknown;
}

export interface OkfDocument {
  frontmatter: OkfFrontmatter;
  /** Markdown body, trailing whitespace trimmed. */
  body: string;
}
