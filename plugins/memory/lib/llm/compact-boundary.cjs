function isCompactBoundary(message) {
  return !!message?.compactBoundary && !message?.compactPreservePrefix;
}

function findLastCompactBoundaryIndex(messages) {
  if (!Array.isArray(messages)) return -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isCompactBoundary(messages[index])) return index;
  }
  return -1;
}

function messagesAfterLastCompactBoundary(messages) {
  if (!Array.isArray(messages)) return [];
  const index = findLastCompactBoundaryIndex(messages);
  return index >= 0 ? messages.slice(index + 1) : messages;
}

module.exports = {
  isCompactBoundary,
  findLastCompactBoundaryIndex,
  messagesAfterLastCompactBoundary,
};
