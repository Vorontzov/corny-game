# Corny Game for iPhone and iPad

Open `CornyGame.xcodeproj` in Xcode 16 or later. The app supports iOS and iPadOS 16 and later. It builds the existing repository's game into a persistent WKWebView, adds touch controls, and uses StoreKit for the Christmas Super-Pack. The game content and music come from the same `index.html` and `audio` folder as GitHub Pages.

## Run on a simulator

1. Open the project and select the **CornyGame** scheme and an iPhone or iPad simulator.
2. Press Run. The build script copies the game, all 26 songs, and pinned libraries into the app. The initial game can start offline. Multiplayer needs an internet connection.
3. Use the left joystick to move, drag the world to look, and tap the large action buttons. Hold Jump to swim up and Dive to swim down. Inventory, chat, crafting, tanks, boats, and all existing gameplay are available.

The command used by GitHub Actions is `xcodebuild -project ios/CornyGame.xcodeproj -scheme CornyGame -sdk iphonesimulator -configuration Debug -derivedDataPath build CODE_SIGNING_ALLOWED=NO build`, from the repository root.

The simulator artifact is for Mac simulators. Installing on a physical device requires signing with your Apple team in Xcode.

## Test purchases without spending money

Select the **CornyGame-StoreKit** scheme. It uses `CornyGame/Christmas.storekit` and the debug-only `-CornyLocalStoreKit` launch argument. These simulated purchases use a separate local gift ledger. Production builds always require a transaction verified by Apple and the CloudKit gift ledger.

Exercise purchase, cancel, Ask to Buy pending approval, restore, refund, relaunch, full inventory, and a failed delivery acknowledgement. The pack unlocks Santa and Gingerbread and delivers exactly 2 gold blocks and 10 emeralds to the first selected saved solo world. Reopening that world retries an interrupted delivery without granting it twice. Test transactions never unlock production purchases.

## Enable real purchases and TestFlight

The account and product setup below still needs the app owner's Apple Developer access.

1. Select your development team in Signing & Capabilities. Register the bundle identifier `com.vorontzov.cornygame`, enable In-App Purchase and iCloud with CloudKit, and provision `iCloud.com.vorontzov.cornygame`. If these identifiers are unavailable, update the project settings, entitlements, StoreController constants, adapter product ID, and StoreKit configuration together.
2. Create the app in App Store Connect. Add **Christmas Super-Pack** as a **non-consumable**, product ID `com.vorontzov.cornygame.christmaspack`, with Family Sharing off. Configure the requested US price of $1.50 if available in App Store Connect. The game displays Apple's actual localized price. Complete Apple's paid-app agreements, tax, and banking setup.
3. Enable the CloudKit development schema for record type `CornyBonusGrant` with fields `worldID` (String), `productID` (String), and `delivered` (Int64). Development delivery can create this schema automatically. Deploy the schema to production before TestFlight or App Store use.
4. Use the normal **CornyGame** scheme and Apple's sandbox testing account to verify the real product and CloudKit together, including two devices on the same iCloud account trying to collect the gift. Check a refund removes paid skin access.
5. Archive for a physical iOS device, upload to App Store Connect, and distribute through TestFlight. Complete the privacy disclosures, age rating, screenshots, support URL, and privacy-policy URL before submitting for App Review.

StoreKit verifies ownership, shows Apple's purchase confirmation, and restores the skins with the purchasing Apple Account. A verified purchase includes an anonymous account token derived from the current iCloud account. That account's private CloudKit ledger records the selected world and delivery acknowledgement, so changing devices or restoring cannot create another copy of the gift. Players must use that same iCloud account to collect the one-time items. An unavailable iCloud service leaves the gift pending. There is no Stripe configuration in the app.

## Saves and networking

Worlds and settings persist in the app's WebKit storage. Browser and app storage are separate, so existing Safari/GitHub Pages worlds do not automatically appear in the app. Deleting the app can remove local worlds. Purchases restore through Apple, and an already delivered item gift is not reissued.

Noobpixel retains its 15-player peer-hosted behavior and device checkpoints. A connected player hosts the public world. PeerJS supplies connection signaling. App and browser players use the same multiplayer protocol.

## Source and privacy

`prepare-web-assets.py` verifies dependency hashes, bundles the root game and audio, replaces CDN libraries with local copies, and inserts the Apple adapter. It does not fetch libraries during a build. `Vendor/sources.json` records pinned source URLs and hashes, with licenses beside the libraries. The app includes no advertising SDK or tracking SDK. The purchase ledger contains the original transaction identifier in its record ID, the product ID, selected world ID, and delivery status in private CloudKit storage. Multiplayer sends the chosen player name and shared game state to connected players. Review these behaviors when completing App Store privacy disclosures.

Changes to game content belong in the shared game. Changes to native purchase handling belong in `CornyGame/StoreController.swift` and `Bridge/apple-store.js`. Use the production scheme for release archives.
