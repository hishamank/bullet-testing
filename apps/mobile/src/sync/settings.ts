/**
 * Device edge: where the home server is and this device's token, kept in the iOS Keychain via
 * expo-secure-store. Pairing UI comes later; until then these are set from a dev screen/console.
 */

import * as SecureStore from 'expo-secure-store'

const URL_KEY = 'bullet.server_url'
const TOKEN_KEY = 'bullet.device_token'

export interface ServerSettings {
  baseUrl: string
  token: string
}

export async function loadServerSettings(): Promise<ServerSettings | null> {
  const [baseUrl, token] = await Promise.all([
    SecureStore.getItemAsync(URL_KEY),
    SecureStore.getItemAsync(TOKEN_KEY),
  ])
  return baseUrl && token ? { baseUrl, token } : null
}

export async function saveServerSettings(s: ServerSettings): Promise<void> {
  await SecureStore.setItemAsync(URL_KEY, s.baseUrl)
  await SecureStore.setItemAsync(TOKEN_KEY, s.token)
}

export async function clearServerSettings(): Promise<void> {
  await SecureStore.deleteItemAsync(URL_KEY)
  await SecureStore.deleteItemAsync(TOKEN_KEY)
}
