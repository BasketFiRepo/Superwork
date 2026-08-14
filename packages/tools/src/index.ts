export * from './registry.js'

// Importing the catalogue registers every tool exactly once.
import './catalogue/retrieval.js'
import './catalogue/tasks.js'
import './catalogue/comms.js'
import './catalogue/meta.js'
import './catalogue/nervous-system.js'
export { buildCustomTool, customToolsFor, compose } from './custom.js'
