// Text-to-speech via the browser's native SpeechSynthesis API — works
// offline using whatever voices the OS provides (no API key, no network
// call), consistent with this app's local-first approach. Electron's
// Chromium supports this directly since it doesn't depend on the Google
// cloud speech services that plain SpeechRecognition (STT) would need.
export function speakText(text: string, voiceURI: string | undefined, onEnd: () => void): void {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    if (voiceURI) {
        const voice = window.speechSynthesis.getVoices().find((v) => v.voiceURI === voiceURI);
        if (voice) utterance.voice = voice;
    }
    utterance.onend = onEnd;
    utterance.onerror = onEnd;
    window.speechSynthesis.speak(utterance);
}

export function stopSpeaking(): void {
    window.speechSynthesis.cancel();
}
