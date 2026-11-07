import CloudKit
import CryptoKit
import Foundation
import StoreKit

/// StoreKit verifies ownership. CloudKit binds the one-time item gift to a world.
@MainActor
final class StoreController {
    static let productID = "com.vorontzov.cornygame.christmaspack"
    private static let containerID = "iCloud.com.vorontzov.cornygame"
    var onChange: (() -> Void)?

    private var product: Product?
    private var entitlement: Transaction?
    private var listener: Task<Void, Never>?
    private var working = false
    private let defaults = UserDefaults.standard
    private lazy var container = CKContainer(identifier: Self.containerID)

    init() {
        listener = Task { [weak self] in
            for await result in Transaction.updates {
                guard !Task.isCancelled else { break }
                guard let self else { break }
                guard case .verified(let transaction) = result,
                      transaction.productID == Self.productID else { continue }
                await self.refreshOwnership()
                // The verified non-consumable remains restorable even if its gift is pending.
                await transaction.finish()
                self.onChange?()
            }
        }
    }

    deinit { listener?.cancel() }

    func handle(_ body: [String: Any]) async throws -> [String: Any] {
        guard body["productID"] as? String == Self.productID,
              let action = body["action"] as? String,
              ["status", "purchase", "restore", "reserveBonus", "ackBonus"].contains(action) else {
            throw StoreFailure("This purchase request is not supported.")
        }
        if action == "status" {
            await refreshOwnership()
            await loadProduct()
            return response()
        }
        guard !working else { throw StoreFailure("Please wait for the current purchase to finish.") }
        working = true
        defer { working = false }
        await refreshOwnership()
        switch action {
        case "purchase":
            if entitlement != nil { return response() }
            await loadProduct()
            guard let product, product.type == .nonConsumable else {
                throw StoreFailure("The Christmas pack is not available from the App Store yet.")
            }
            let token = try await accountToken(testing: isLocalStoreKitProduct)
            switch try await product.purchase(options: [.appAccountToken(token)]) {
            case .success(let verification):
                guard case .verified(let transaction) = verification,
                      transaction.productID == Self.productID,
                      transaction.revocationDate == nil else {
                    throw StoreFailure("Apple could not verify this purchase. Use Restore Purchases to check again.")
                }
                entitlement = transaction
                await transaction.finish()
                onChange?()
                return response()
            case .userCancelled:
                return response(outcome: "cancelled")
            case .pending:
                return response(outcome: "pending")
            @unknown default:
                throw StoreFailure("The purchase is still being processed. Check again shortly.")
            }
        case "restore":
            try await AppStore.sync()
            await refreshOwnership()
            await loadProduct()
            onChange?()
            return response()
        case "reserveBonus", "ackBonus":
            guard let transaction = entitlement else {
                throw StoreFailure("Restore your Christmas pack purchase before collecting the gift.")
            }
            guard let worldID = body["worldID"] as? String,
                  worldID.range(of: "^[A-Za-z0-9_-]{1,120}$", options: .regularExpression) != nil else {
                throw StoreFailure("Open a saved solo world to collect the gift.")
            }
            let token = try await accountToken(testing: isLocalTransaction(transaction))
            guard transaction.appAccountToken == token else {
                throw StoreFailure("Use the iCloud account used for this purchase to collect its one-time items. Your skins are restored.")
            }
            let grant = try await updateBonus(transaction: transaction, worldID: worldID, acknowledge: action == "ackBonus")
            defaults.set(["worldID": grant.worldID, "delivered": grant.delivered], forKey: cacheKey(transaction))
            return response()
        default:
            throw StoreFailure("This purchase request is not supported.")
        }
    }

    private func refreshOwnership() async {
        var owned: Transaction?
        for await result in Transaction.currentEntitlements {
            guard case .verified(let transaction) = result,
                  transaction.productID == Self.productID,
                  transaction.revocationDate == nil, !transaction.isUpgraded else { continue }
            owned = transaction
        }
        entitlement = owned
    }

    private func loadProduct() async {
        guard product == nil else { return }
        product = try? await Product.products(for: [Self.productID]).first
    }

    private func response(outcome: String? = nil) -> [String: Any] {
        let cached = entitlement.flatMap { defaults.dictionary(forKey: cacheKey($0)) }
        var reply: [String: Any] = [
            "owned": entitlement != nil,
            "transactionID": entitlement.map { String($0.originalID) } as Any? ?? NSNull(),
            "displayPrice": product?.displayPrice as Any? ?? NSNull(),
            "available": product != nil,
            "bonus": ["worldID": cached?["worldID"] ?? NSNull(), "delivered": cached?["delivered"] as? Bool ?? false]
        ]
        if let outcome { reply["outcome"] = outcome }
        return reply
    }

    private func cacheKey(_ transaction: Transaction) -> String {
        "corny.apple.bonus.\(transaction.environment.rawValue).\(transaction.originalID)"
    }

    private var isLocalStoreKitProduct: Bool {
        #if DEBUG
        return ProcessInfo.processInfo.arguments.contains("-CornyLocalStoreKit")
        #else
        return false
        #endif
    }

    private func isLocalTransaction(_ transaction: Transaction) -> Bool {
        #if DEBUG
        return transaction.environment == .xcode && isLocalStoreKitProduct
        #else
        return false
        #endif
    }

    private func accountToken(testing: Bool) async throws -> UUID {
        #if DEBUG
        if testing { return UUID(uuidString: "045264C2-2118-42E3-9BD9-D89B794B8515")! }
        #endif
        guard try await container.accountStatus() == .available else {
            throw StoreFailure("Sign in to iCloud in Settings to save the one-time Christmas gift with your purchase.")
        }
        let user = try await container.userRecordID()
        let digest = SHA256.hash(data: Data((Self.containerID + ":" + user.recordName).utf8))
        let bytes = Array(digest.prefix(16))
        return UUID(uuid: (bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
                           bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]))
    }

    private struct BonusGrant {
        let worldID: String
        let delivered: Bool
    }

    private func updateBonus(transaction: Transaction, worldID: String, acknowledge: Bool) async throws -> BonusGrant {
        if isLocalTransaction(transaction) {
            let key = cacheKey(transaction)
            let saved = defaults.dictionary(forKey: key)
            let destination = saved?["worldID"] as? String ?? worldID
            if acknowledge && saved == nil { throw StoreFailure("Collect the gift in a world before confirming delivery.") }
            return BonusGrant(worldID: destination, delivered: saved?["delivered"] as? Bool == true || (acknowledge && destination == worldID))
        }
        let database = container.privateCloudDatabase
        let id = CKRecord.ID(recordName: "christmas-\(transaction.environment.rawValue)-\(transaction.originalID)")
        for _ in 0..<3 {
            let record: CKRecord
            do {
                record = try await database.record(for: id)
            } catch let error as CKError where error.code == .unknownItem {
                guard !acknowledge else { throw StoreFailure("Collect the gift in a world before confirming delivery.") }
                record = CKRecord(recordType: "CornyBonusGrant", recordID: id)
                record["worldID"] = worldID as CKRecordValue
                record["delivered"] = NSNumber(value: false)
                record["productID"] = Self.productID as CKRecordValue
            }
            guard let destination = record["worldID"] as? String,
                  record["productID"] as? String == Self.productID else {
                throw StoreFailure("The gift record could not be verified. Try Restore Purchases.")
            }
            let delivered = (record["delivered"] as? NSNumber)?.boolValue ?? false
            if destination != worldID || delivered { return BonusGrant(worldID: destination, delivered: delivered) }
            if acknowledge { record["delivered"] = NSNumber(value: true) }
            do {
                let result = try await database.modifyRecords(saving: [record], deleting: [], savePolicy: .ifServerRecordUnchanged, atomically: false)
                guard let save = result.saveResults[id] else { throw StoreFailure("The gift could not be saved. Please try again.") }
                let saved = try save.get()
                return BonusGrant(worldID: destination, delivered: (saved["delivered"] as? NSNumber)?.boolValue ?? false)
            } catch let error as CKError where error.code == .serverRecordChanged {
                // Another device claimed or acknowledged this same transaction. Read its result.
                continue
            }
        }
        throw StoreFailure("Another device is updating this gift. Reopen your world shortly.")
    }
}

private struct StoreFailure: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
