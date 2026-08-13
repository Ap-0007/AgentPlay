function chooseSubtitleEngine({ preference = 'auto', cloudReady = false, offlineAvailable = false } = {}) {
  if (preference === 'local') return offlineAvailable ? 'offline' : null
  if (preference === 'cloud') return cloudReady ? 'cloud' : offlineAvailable ? 'offline' : null
  if (cloudReady) return 'cloud'
  if (offlineAvailable) return 'offline'
  return null
}

module.exports = { chooseSubtitleEngine }
