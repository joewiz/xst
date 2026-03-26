import chalk from 'chalk'

import { getXmlRpcClient } from '@existdb/node-exist'

import { isDBAdmin, getUserInfo, getApiClient } from '../../../utility/connection.js'
import {
  findCompatibleVersion,
  getInstalledPackageMeta,
  getInstalledPackageMetaViaApi,
  installFromRepo,
  installFromRepoViaApi
} from '../../../utility/package.js'
import { fail, logSuccess, logSkipped } from '../../../utility/message.js'

export const command = [
  'from-registry <package> [<version>]',
  'registry <package> [<version>]'
]
export const describe = 'Install a package from a registry (AKA public-repo)'

export const builder = (yargs) => {
  return yargs
    .version(false)
    .positional('package', {
      describe: "The package's name or its abbrev",
      string: true
    })
    .positional('version', {
      describe: 'The version to install',
      default: '',
      string: true
    })
}

export async function handler (argv) {
  if (argv.help) {
    return 0
  }
  const { connectionOptions, registry, force, verbose } = argv

  const api = await getApiClient(argv)
  if (api) {
    return handlerViaApi(api, argv)
  }

  // Fallback: XML-RPC + embedded XQuery
  const db = getXmlRpcClient(connectionOptions)

  // check permissions (and therefore implicitly the connection)
  const user = await getUserInfo(db)
  if (!isDBAdmin(user)) {
    throw Error(
      `Package installation failed. User "${user.name}" is not a DB administrator.`
    )
  }

  const info = await getInstalledPackageMeta(db, argv.package)

  if (verbose) {
    const installedOrNot = info.version ? `already installed in version ${info.version}` : 'not installed yet'
    console.error(`Package ${info.name || argv.package} is ${installedOrNot}.`)
  }

  let pkgInfo
  try {
    pkgInfo = await findCompatibleVersion(db, { nameOrAbbrev: argv.package, version: argv.version, registryUrl: registry, verbose })
  } catch (e) {
    throw new Error(`${fail} ${chalk.dim(argv.package)} > ${e.message}`)
  }

  const isUpToDate = pkgInfo.version && pkgInfo.version === info.version

  if (!force && isUpToDate) {
    logSkipped(
      `${chalk.dim(argv.package)} > ${info.version} is already installed`
    )
    console.error(
      chalk.yellow('If you wish to force installation use --force.')
    )
    return 0
  }

  const { success, result } = await installFromRepo(db, {
    registryUrl: registry,
    packageName: pkgInfo.name,
    version: pkgInfo.version,
    verbose
  })

  if (!success) {
    throw new Error(`${fail} ${chalk.dim(argv.package)} > ${result}`)
  }

  logSuccess(
    `${chalk.dim(argv.package)} > installed version ${result.version} at ${result.target}`
  )

  return 0
}

/**
 * Install via exist-api REST backend.
 * Uses the same flow as the XML-RPC handler but routes through REST endpoints.
 */
async function handlerViaApi (api, argv) {
  const { registry, force, verbose } = argv

  // Admin check via whoami
  const whoami = await api.whoami()
  if (!whoami.real || !whoami.real.groups.includes('dba')) {
    throw Error(
      `Package installation failed. User "${whoami.real?.user || 'unknown'}" is not a DB administrator.`
    )
  }

  const info = await getInstalledPackageMetaViaApi(api, argv.package)

  if (verbose) {
    const installedOrNot = info.version ? `already installed in version ${info.version}` : 'not installed yet'
    console.error(`Package ${info.name || argv.package} is ${installedOrNot}.`)
  }

  // findCompatibleVersion queries the external registry directly — no eXist involvement.
  // But it needs db.server.version() which we don't have via REST.
  // For now, get version from system/info endpoint.
  const sysInfo = await api.getSystemInfo()
  const processor = sysInfo.db?.version || '7.0.0'

  let pkgInfo
  try {
    pkgInfo = await findCompatibleVersionDirect({ nameOrAbbrev: argv.package, version: argv.version, registryUrl: registry, verbose, processor })
  } catch (e) {
    throw new Error(`${fail} ${chalk.dim(argv.package)} > ${e.message}`)
  }

  const isUpToDate = pkgInfo.version && pkgInfo.version === info.version

  if (!force && isUpToDate) {
    logSkipped(
      `${chalk.dim(argv.package)} > ${info.version} is already installed`
    )
    console.error(
      chalk.yellow('If you wish to force installation use --force.')
    )
    return 0
  }

  const { success, result } = await installFromRepoViaApi(api, {
    registryUrl: registry,
    packageName: pkgInfo.name,
    version: pkgInfo.version,
    verbose
  })

  if (!success) {
    throw new Error(`${fail} ${chalk.dim(argv.package)} > ${result}`)
  }

  logSuccess(
    `${chalk.dim(argv.package)} > installed version ${result.version || pkgInfo.version} at ${result.target}`
  )

  return 0
}

/**
 * Query the registry directly without needing an XML-RPC db client.
 * Adapted from findCompatibleVersion in package.js but takes processor version
 * as a parameter instead of querying it from the db.
 */
async function findCompatibleVersionDirect ({ nameOrAbbrev, version, verbose, registryUrl, processor }) {
  const { createExistClient } = await import('@existdb/node-exist/util/exist-client.js')
  const baseParams = { processor, info: true }
  if (version) {
    baseParams.version = version
  }
  const { client } = createExistClient({
    server: registryUrl,
    throwOnError: true,
    headers: {
      accept: 'application/json,*/*',
      'User-Agent': 'xst/undici.Client'
    }
  })

  const abbrevSearchRequest = {
    method: 'GET',
    path: 'find',
    query: { ...baseParams, abbrev: nameOrAbbrev }
  }

  if (verbose) {
    const query = new URLSearchParams(abbrevSearchRequest.query)
    console.error(`Resolving by abbrev: ${registryUrl}/${abbrevSearchRequest.path}?${query.toString()}`)
  }

  let statusCode
  try {
    const response = await client.request(abbrevSearchRequest)
    statusCode = response.statusCode
    return await response.body.json()
  } catch (err) {
    if (err?.code === 'ECONNREFUSED') {
      throw new Error(`Could not connect to ${registryUrl}`)
    }
    // Fallback to name search
    if (err?.statusCode === 404) {
      if (verbose) {
        console.log('Falling back to name search')
      }
      const nameSearchRequest = {
        method: 'GET',
        path: 'find',
        query: { ...baseParams, name: nameOrAbbrev }
      }
      try {
        const { body } = await client.request(nameSearchRequest)
        return await body.json()
      } catch (errName) {
        if (errName?.statusCode === 404) {
          throw new Error('Package could not be found in the registry!')
        }
        throw new Error(errName.message)
      }
    }
    throw new Error(`Error connecting to ${registryUrl}. Status code: ${statusCode || err?.statusCode}`)
  }
}
