import * as Speech from "expo-speech";

export class InspectionAnnouncer {
  private enabled = false;

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) {
      Speech.stop();
    }
  }

  async announceFinding(roomName: string, description: string): Promise<void> {
    if (!this.enabled) return;
    await this.speak(`Alert in ${roomName}. ${description}`);
  }

  async announceCoverage(roomName: string): Promise<void> {
    if (!this.enabled) return;
    await this.speak(`${roomName} complete. Moving to next room.`);
  }

  async announceStatus(message: string): Promise<void> {
    if (!this.enabled) return;
    await this.speak(message);
  }

  private async speak(text: string): Promise<void> {
    try {
      await Speech.stop();
      await Speech.speak(text, {
        rate: 0.95,
      });
    } catch {
      // Ignore speech failures so inspection flow is never blocked.
    }
  }
}
