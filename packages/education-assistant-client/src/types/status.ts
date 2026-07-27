import type { components } from './generated';

/**
 * GET /status — protected (requires a token, unlike /health and
 * /health/ready). Never includes raw document text, filesystem paths, API
 * keys, private environment variables, or system prompts — see the
 * backend's app/api/routes_status.py.
 */
export type StatusResponse = components['schemas']['StatusResponse'];
