import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'app.boostline.logger',
  appName: 'Boostline',
  webDir: 'dist-mobile',
  backgroundColor: '#050505',
  ios: {
    contentInset: 'never',
    backgroundColor: '#050505'
  }
}

export default config
