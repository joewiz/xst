import chalk from 'chalk'
import { getXmlRpcClient } from '@existdb/node-exist'
import { readXquery } from '../../utility/xq.js'
import { getApiClient } from '../../utility/connection.js'

const query = readXquery('uninstall.xq')

async function getUserInfo (db) {
  const { user } = db.connection
  return await db.users.getUserInfo(user)
}

async function uninstall (nameOrAbbrev, db, options) {
  const { force, raw } = options
  const { pages } = await db.queries.readAll(query, { variables: { 'name-or-abbrev': nameOrAbbrev, force } })
  const rawResult = pages.toString()
  const result = JSON.parse(rawResult)
  if (result.error && !result.error.code.startsWith('local:')) {
    throw new Error(result.error.description)
  }
  const success = Boolean(result.error)
  if (raw) {
    console.log(rawResult)
    return success
  }
  if (result.error) {
    const errorIndicator = chalk.red('✘')
    const extra = result.error.value ? `: ${result.error.value.join(', ')}` : ''
    console.error(`${errorIndicator} ${result.error.description}${extra}`)
    return success
  }
  const successIndicator = chalk.green('✔︎')
  console.log(`${successIndicator} ${result.name} uninstalled`)
  return success
}

export const command = ['uninstall [options] <packages..>', 'remove']
export const describe = 'Uninstall packages'

const options = {
  f: {
    alias: 'force',
    describe: 'Force uninstall without dependency check',
    type: 'boolean',
    default: false
  },
  raw: {
    describe: 'Return raw JSON returned from server',
    type: 'boolean',
    default: false
  }
}

export const builder = yargs => yargs.options(options)

/**
 * uninstall a package via exist-api REST endpoint
 * @param {string} nameOrAbbrev
 * @param {object} api exist-api client
 * @param {object} options
 * @returns {boolean} success
 */
async function uninstallViaApi (nameOrAbbrev, api, options) {
  const { force, raw } = options
  const result = await api.removePackage(nameOrAbbrev, force)
  if (raw) {
    console.log(JSON.stringify(result))
    return !result.error
  }
  if (result.error) {
    const errorIndicator = chalk.red('✘')
    const extra = result.dependents ? `: ${result.dependents.join(', ')}` : ''
    console.error(`${errorIndicator} ${result.error}${extra}`)
    return false
  }
  const successIndicator = chalk.green('✔︎')
  console.log(`${successIndicator} ${result.name} uninstalled`)
  return true
}

export async function handler (argv) {
  if (argv.help) {
    return 0
  }

  const api = await getApiClient(argv)
  if (api) {
    // Verify admin via whoami
    const whoami = await api.whoami()
    if (!whoami.real || !whoami.real.groups.includes('dba')) {
      throw Error(`User "${whoami.real?.user || 'unknown'}" is not a member of the "dba" group.`)
    }
    const results = []
    for (const i in argv.packages) {
      results.push(await uninstallViaApi(argv.packages[i], api, argv))
    }
    return (results.filter(r => !r).length ? 1 : 0)
  }

  // Fallback to XML-RPC
  const db = getXmlRpcClient(argv.connectionOptions)
  const accountInfo = await getUserInfo(db)
  const isAdmin = accountInfo.groups.includes('dba')
  if (!isAdmin) {
    throw Error(`User "${accountInfo.name}" is not a member of the "dba" group.`)
  }

  const results = []
  for (const i in argv.packages) {
    const nameOrAbbrev = argv.packages[i]
    results.push(await uninstall(nameOrAbbrev, db, argv))
  }

  return (results.filter(r => !r).length ? 1 : 0)
}
