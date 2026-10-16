export interface DeviceKeyBundle {
  userId: string;
  deviceId: string;
  identityKey: string;
  signedPreKey: string;
  preKeySignature: string;
  mlKemPublicKey?: string; // NIST ML-KEM hybrid key representation (PQ3-inspired)
  oneTimePreKeys: string[];
  createdAt: string;
}

export interface EncryptedMessagePayload {
  epoch: number;
  senderDeviceId: string;
  ciphertext: string;
  recipientKeyWraps: Record<string, string>; // recipientUserId -> wrapped AES key
}

export interface E2EEKeyManager {
  registerDeviceBundle(bundle: DeviceKeyBundle): Promise<void>;
  getRecipientBundles(userIds: string[]): Promise<Record<string, DeviceKeyBundle>>;
  rotateEpochKeys(chatId: string, authorizedUserIds: string[]): Promise<{ epoch: number }>;
}

export class InMemoryKeyRegistry implements E2EEKeyManager {
  private bundles = new Map<string, DeviceKeyBundle>();
  private chatEpochs = new Map<string, number>();

  async registerDeviceBundle(bundle: DeviceKeyBundle): Promise<void> {
    this.bundles.set(bundle.userId, bundle);
  }

  async getRecipientBundles(userIds: string[]): Promise<Record<string, DeviceKeyBundle>> {
    const result: Record<string, DeviceKeyBundle> = {};
    for (const id of userIds) {
      const bundle = this.bundles.get(id);
      if (bundle) {
        result[id] = bundle;
      }
    }
    return result;
  }

  async rotateEpochKeys(chatId: string, authorizedUserIds: string[]): Promise<{ epoch: number }> {
    const current = this.chatEpochs.get(chatId) || 0;
    const nextEpoch = current + 1;
    this.chatEpochs.set(chatId, nextEpoch);
    return { epoch: nextEpoch };
  }
}

export const keyRegistry = new InMemoryKeyRegistry();
