import { getXmlRpcClient } from '@existdb/node-exist'
import { readXquery } from '../utility/xq.js'
import { getApiClient } from '../utility/connection.js'

/**
 * @typedef { import("@existdb/node-exist").NodeExist } NodeExist
 */

/**
 * the xquery file to execute on the DB
 */
const query = readXquery('rm.xq')

const protectedPaths = [
  '/',
  '/db',
  '/db/apps',
  '/db/system',
  '/db/system/config',
  '/db/system/repo',
  '/db/system/security',
  '/db/system/security/exist',
  '/db/system/security/exist/accounts',
  '/db/system/security/exist/groups'
]

function guardProtectedPaths (paths) {
  let foundProtectedPaths = false
  paths.forEach(path => {
    if (path === '') {
      console.error('Cannot remove protected path: /')
      foundProtectedPaths = true
      return
    }
    if (protectedPaths.includes(path)) {
      console.error(`Cannot remove protected path: ${path}`)
      foundProtectedPaths = true
    }
  })
  return foundProtectedPaths
}

function normalizePath (path) {
  if (path.endsWith('/')) {
    return path.substring(0, path.length - 1)
  }
  return path
}

/**
 * remove collections and resources in exist db
 * @param {NodeExist} db database client
 * @param {[String]} paths path to collection in db
 * @param {RemoveOptions} options command line options
 * @returns {void}
 */
async function rm (db, paths, options) {
  const { /* glob, dryRun, */ recursive, force } = options
  const result = await db.queries.readAll(query, {
    variables: {
      paths,
      // glob,
      // dryRun,
      recursive,
      force
    }
  })
  const json = await JSON.parse(result.pages.toString())
  if (json.error) {
    if (options.debug) {
      console.error(json.error)
    }
    throw Error(json.error.description)
  }
  if (options.debug) {
    console.log(json)
  }

  json.list.forEach(item => {
    const { success, path } = item
    if (success) {
      console.log('✔︎ ' + path)
      return
    }
    console.error('✘ ' + path + ' - ' + item.error.description)
  })
}

export const command = ['remove [options] <paths..>', 'rm', 'delete', 'del']
export const describe = 'Remove collections or resources'

const options = {
  // g: {
  //   alias: 'glob',
  //   describe:
  //         'remove only collection names and resources whose name match the pattern.',
  //   type: 'string',
  //   default: '*'
  // },
  // d: {
  //   alias: 'dry-run',
  //   describe: 'Only list what would be deleted',
  //   type: 'boolean'
  // },
  r: {
    alias: 'recursive',
    describe: 'Descend down the collection tree',
    type: 'boolean',
    default: false
  },
  f: {
    alias: 'force',
    describe: 'Force deletion of non-empty collections',
    type: 'boolean',
    default: false
  }
}

export const builder = yargs => yargs.options(options)

/**
 * handle rm command
 * @param {RemoveOptions} argv options
 * @returns {Number} exit code
 */
/**
 * remove paths via exist-api REST endpoints
 * @param {object} api exist-api client
 * @param {string[]} paths paths to remove
 * @param {object} options command line options
 */
async function rmViaApi (api, paths, options) {
  const { recursive, force } = options
  for (const path of paths) {
    // First check if it's a collection by trying to list it
    const listing = await api.listCollection(path, {})
    const isCollection = listing.type === 'collection'

    let result
    if (isCollection) {
      if (!recursive) {
        console.error('✘ ' + path + ' - is a collection, but the recursive option is not set')
        continue
      }
      const params = new URLSearchParams({ path })
      if (force) params.set('force', 'true')
      result = await api.remove(path, { isCollection: true, force })
    } else {
      result = await api.remove(path, { isCollection: false })
    }

    if (result.error) {
      console.error('✘ ' + path + ' - ' + (result.error.description || result.error))
    } else {
      console.log('✔︎ ' + path)
    }
  }
}

export async function handler (argv) {
  if (argv.help) {
    return 0
  }
  const { /* glob, */ paths, connectionOptions } = argv

  const normalized = paths.map(normalizePath)

  if (guardProtectedPaths(normalized)) {
    return 1
  }

  const api = await getApiClient(argv)
  if (api) {
    return rmViaApi(api, normalized, argv)
  }

  const db = getXmlRpcClient(connectionOptions)

  return rm(db, normalized, argv)
}
