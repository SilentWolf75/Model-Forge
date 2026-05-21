import packageJson from '../../../package.json'

/**
 * Shown in the About dialog. Comes from `package.json` `version` so there is a single release string
 * (e.g. `1.0.0-beta.10`) for the app UI, installers, and npm.
 */
export const DISPLAY_VERSION: string = packageJson.version
