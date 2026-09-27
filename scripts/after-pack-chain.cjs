'use strict'

// electron-builder accepts a single afterPack hook; the merge left the config
// with a duplicate key (fork darwin cleanup vs upstream PPT-runtime verify),
// where JSON parsing silently keeps only the last one. Chain both explicitly:
// remove the dead darwin Node binary first, then verify the packaged runtime.

module.exports = async function afterPack(context) {
  await require('./after-pack.cjs')(context)
  await require('./verify-packaged-ppt-runtime.cjs')(context)
}
