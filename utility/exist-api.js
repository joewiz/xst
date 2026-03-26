/**
 * REST client for the exist-api platform API.
 *
 * When exist-api is installed on an eXist-db instance, xst can use
 * these REST endpoints instead of executing embedded XQuery modules.
 * This eliminates ~750 lines of embedded XQuery and gives xst stable,
 * documented API contracts.
 *
 * Capability probe: GET /api/users/whoami — if it returns 200, the
 * exist-api package is installed and all REST endpoints are available.
 */

/**
 * Build the base URL for the exist-api REST endpoints.
 * @param {object} connectionOptions from @existdb/node-exist
 * @returns {string} base URL like "http://localhost:8080/exist/apps/exist-api"
 */
export function getBaseUrl (connectionOptions) {
  const { protocol, host, port } = connectionOptions
  return `${protocol}//${host}:${port}/exist/apps/exist-api`
}

/**
 * Build Authorization header from connection options.
 * @param {object} connectionOptions
 * @returns {string} Basic auth header value
 */
function getAuthHeader (connectionOptions) {
  const { user, pass } = connectionOptions.basic_auth
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')
}

/**
 * Make a request to the exist-api.
 * @param {string} baseUrl
 * @param {string} path endpoint path (e.g., "/api/system/info")
 * @param {object} connectionOptions
 * @param {object} [options] fetch options override
 * @returns {Promise<object>} parsed JSON response
 */
async function apiRequest (baseUrl, path, connectionOptions, options = {}) {
  const url = baseUrl + path
  const response = await fetch(url, {
    headers: {
      Authorization: getAuthHeader(connectionOptions),
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...options.headers
    },
    ...options
  })
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    return { error: { description: text || `HTTP ${response.status}` } }
  }
}

/**
 * Probe whether exist-api is installed on the target eXist-db instance.
 * Uses GET /api/users/whoami as the capability probe.
 *
 * @param {object} connectionOptions
 * @returns {Promise<boolean>} true if exist-api is available
 */
export async function probeExistApi (connectionOptions) {
  try {
    const baseUrl = getBaseUrl(connectionOptions)
    const response = await fetch(baseUrl + '/api/users/whoami', {
      headers: {
        Authorization: getAuthHeader(connectionOptions),
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(3000)
    })
    if (!response.ok) return false
    const body = await response.json()
    return Boolean(body.real && body.real.user)
  } catch {
    return false
  }
}

/**
 * Create an exist-api client bound to connection options.
 * @param {object} connectionOptions
 * @returns {object} client with methods for each endpoint group
 */
export function createApiClient (connectionOptions) {
  const baseUrl = getBaseUrl(connectionOptions)
  const req = (path, options) => apiRequest(baseUrl, path, connectionOptions, options)

  return {
    /** GET /api/system/info */
    getSystemInfo: () => req('/api/system/info'),

    /** GET /api/users/whoami */
    whoami: () => req('/api/users/whoami'),

    /**
     * GET /api/db
     * @param {string} path collection path
     * @param {object} [opts] { recursive, depth, glob, collectionsOnly }
     */
    listCollection: (path, opts = {}) => {
      const params = new URLSearchParams({ path })
      if (opts.recursive) params.set('recursive', 'true')
      if (opts.depth) params.set('depth', String(opts.depth))
      if (opts.glob && opts.glob !== '*') params.set('glob', opts.glob)
      if (opts.collectionsOnly) params.set('collections-only', 'true')
      return req(`/api/db?${params}`)
    },

    /**
     * DELETE /api/db/resource or /api/db/collection
     * @param {string} path resource or collection path
     * @param {object} [opts] { isCollection, force }
     */
    remove: (path, opts = {}) => {
      if (opts.isCollection) {
        const params = new URLSearchParams({ path })
        if (opts.force) params.set('force', 'true')
        return req(`/api/db/collection?${params}`, { method: 'DELETE' })
      }
      const params = new URLSearchParams({ path })
      return req(`/api/db/resource?${params}`, { method: 'DELETE' })
    },

    /** GET /api/packages */
    listPackages: () => req('/api/packages'),

    /**
     * GET /api/packages/{name}
     * @param {string} nameOrAbbrev package name URI or abbreviation
     */
    getPackage: (nameOrAbbrev) =>
      req(`/api/packages/${encodeURIComponent(nameOrAbbrev)}`),

    /**
     * POST /api/packages/install
     * @param {string} name package name URI
     * @param {string} registryUrl registry find URL
     * @param {string} [version] specific version (empty for latest)
     */
    installPackage: (name, registryUrl, version = '') =>
      req('/api/packages/install', {
        method: 'POST',
        body: JSON.stringify({ name, url: registryUrl, version })
      }),

    /**
     * DELETE /api/packages/{name}
     * @param {string} nameOrAbbrev package name or abbreviation
     * @param {boolean} [force] force removal ignoring dependents
     */
    removePackage: (nameOrAbbrev, force = false) => {
      const params = force ? '?force=true' : ''
      return req(`/api/packages/${encodeURIComponent(nameOrAbbrev)}${params}`, {
        method: 'DELETE'
      })
    }
  }
}
