// Adopts the UIScene life cycle, which the iOS 27 SDK requires: an app built with it that still
// uses the app-delegate window traps at launch (`_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`).
//
// Expo SDK 57's bare template predates this; the SDK 58 template does it natively. This plugin
// applies the SDK 58 template's changes on prebuild using `ExpoAppSceneDelegate`, which
// `expo@57.0.30` already ships:
//   - Info.plist gets a UIApplicationSceneManifest pointing at `SceneDelegate`.
//   - SceneDelegate.swift (a bare `ExpoAppSceneDelegate` subclass) is added to the app target.
//   - AppDelegate conforms to `ExpoReactNativeFactoryProvider` and no longer creates the window or
//     starts React Native (the scene delegate does both).
// Remove this plugin when upgrading to Expo SDK 58.
const fs = require('node:fs')
const path = require('node:path')
const {
  IOSConfig,
  withAppDelegate,
  withInfoPlist,
  withXcodeProject,
} = require('expo/config-plugins')

const SCENE_DELEGATE = `internal import Expo

@objc(SceneDelegate)
class SceneDelegate: ExpoAppSceneDelegate {
  // Extension point for config plugins.
}
`

const WINDOW_BLOCK =
  /\n#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n\s*factory\.startReactNative\([\s\S]*?\)\n#endif\n/

function patchAppDelegate(contents) {
  let out = contents
  if (!out.includes('ExpoReactNativeFactoryProvider')) {
    const decl = 'class AppDelegate: ExpoAppDelegate {'
    if (!out.includes(decl))
      throw new Error('with-scene-lifecycle: AppDelegate declaration not found')
    out = out.replace(decl, 'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {')
  }
  if (out.includes('UIWindow(frame: UIScreen.main.bounds)')) {
    if (!WINDOW_BLOCK.test(out)) {
      throw new Error('with-scene-lifecycle: AppDelegate window setup not in the expected shape')
    }
    out = out.replace(
      WINDOW_BLOCK,
      '\n    // The window is created and React Native is started by `SceneDelegate` under the\n' +
        '    // scene-based life cycle (required by the iOS 27 SDK).\n',
    )
  }
  return out
}

const withSceneLifecycle = (config) => {
  config = withInfoPlist(config, (cfg) => {
    cfg.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: 'Default Configuration',
            UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate',
          },
        ],
      },
    }
    return cfg
  })

  config = withAppDelegate(config, (cfg) => {
    if (cfg.modResults.language !== 'swift') {
      throw new Error('with-scene-lifecycle: expected a Swift AppDelegate')
    }
    cfg.modResults.contents = patchAppDelegate(cfg.modResults.contents)
    return cfg
  })

  config = withXcodeProject(config, (cfg) => {
    const { projectRoot, platformProjectRoot } = cfg.modRequest
    const projectName = IOSConfig.XcodeUtils.getProjectName(projectRoot)
    const relPath = `${projectName}/SceneDelegate.swift`
    fs.writeFileSync(path.join(platformProjectRoot, relPath), SCENE_DELEGATE)
    if (!cfg.modResults.hasFile(relPath)) {
      IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
        filepath: relPath,
        groupName: projectName,
        project: cfg.modResults,
      })
    }
    return cfg
  })

  return config
}

module.exports = withSceneLifecycle
