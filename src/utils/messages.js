export function formatUserGroupMention(userGroupId) {
  if (!userGroupId) {
    return '';
  }

  return `<!subteam^${userGroupId}>`;
}

function trimOrEmpty(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim();
}

export function formatDailyUpdateMessage({
  userGroupId,
  mainUpdateText,
  songText,
  eventText,
  questionText,
  stepsText,
  includeQuestion = false,
}) {
  const messageSections = [];
  const groupMention = formatUserGroupMention(userGroupId);

  if (groupMention) {
    messageSections.push(groupMention);
  }

  messageSections.push('*DAILY UPDATE*');

  const updateBody = trimOrEmpty(contentToMrkdwn(mainUpdateText));
  if (updateBody) {
    messageSections.push(updateBody);
  }

  if (includeQuestion && trimOrEmpty(questionText)) {
    messageSections.push(`*Daily Question*\n${trimOrEmpty(questionText)}`);
  }

  const footerLines = [];
  const songLine = trimOrEmpty(songText);
  const eventLine = trimOrEmpty(eventText);
  const stepsLine = trimOrEmpty(stepsText);

  if (songLine) {
    footerLines.push(`Song of the Day: ${songLine}`);
  }

  if (eventLine) {
    footerLines.push(`Event of the Day: ${eventLine}`);
  }

  if (stepsLine) {
    footerLines.push(stepsLine);
  }

  if (footerLines.length > 0) {
    messageSections.push('----------');
    messageSections.push(...footerLines);
  }

  return messageSections.join('\n\n');
}

export function formatDailyQuestionMessage(questionText, introText = 'Reply to this message in a thread!') {
  return ['❓ Daily Question', trimOrEmpty(questionText), trimOrEmpty(introText)].filter(Boolean).join('\n\n');
}

export function replaceWelcomePlaceholders(templateText, { userId }) {
  const template = trimOrEmpty(templateText) || 'Welcome {user}! 🎉';
  return template.replaceAll('{user}', `<@${userId}>`);
}

export function normalizeQuestionText(questionText) {
  return trimOrEmpty(questionText)
    .replace(/^[-*\d.\s]+/, '')
    .replace(/\s+/g, ' ')
    .replace(/["“”]+$/g, '')
    .replace(/^['"“”]+/g, '')
    .trim();
}

export function isRepeatedQuestion(questionText, recentQuestions) {
  const candidate = normalizeQuestionText(questionText).toLowerCase();
  if (!candidate) {
    return true;
  }

  return recentQuestions.some(
    (previousQuestion) => normalizeQuestionText(previousQuestion).toLowerCase() === candidate,
  );
}

function richTextElementToMrkdwn(element) {
  if (!element) {
    return '';
  }

  let text = '';
  switch (element.type) {
    case 'text':
      text = element.text ?? '';
      break;
    case 'link':
      text = element.url
        ? element.text
          ? `<${element.url}|${element.text}>`
          : `<${element.url}>`
        : (element.text ?? '');
      break;
    case 'user':
      text = `<@${element.user_id}>`;
      break;
    case 'usergroup':
      text = `<!subteam^${element.usergroup_id}>`;
      break;
    case 'channel':
      text = `<#${element.channel_id}>`;
      break;
    case 'emoji':
      text = element.name ? `:${element.name}:` : (element.unicode ?? '');
      break;
    case 'broadcast':
      text = element.range === 'here' ? '<!here>' : element.range === 'everyone' ? '<!everyone>' : '<!channel>';
      break;
    case 'date':
      text = element.timestamp
        ? `<!date^${element.timestamp}^${element.format || '{date}'}|${element.fallback || ''}>`
        : (element.fallback ?? '');
      break;
    default:
      text = '';
  }

  if (element.code) {
    text = `\`${text}\``;
  }
  if (element.italic) {
    text = `_${text}_`;
  }
  if (element.bold) {
    text = `*${text}*`;
  }
  if (element.strike) {
    text = `~${text}~`;
  }

  return text;
}

function richTextSectionToMrkdwn(section) {
  if (!section) {
    return '';
  }

  if (section.type === 'rich_text_list') {
    const isOrdered = section.style === 'ordered';
    return (section.elements || [])
      .map((item, index) => {
        const itemText = richTextSectionToMrkdwn(item);
        return `${isOrdered ? `${index + 1}.` : '•'} ${itemText}`;
      })
      .join('\n');
  }

  if (section.type === 'rich_text_quote') {
    return (section.elements || [])
      .map((line) =>
        richTextSectionToMrkdwn(line)
          .split('\n')
          .map((text) => `> ${text}`)
          .join('\n'),
      )
      .join('\n');
  }

  if (section.type === 'rich_text_preformatted') {
    return `\`\`\`\n${(section.elements || []).map(richTextElementToMrkdwn).join('')}\n\`\`\``;
  }

  return (section.elements || []).map(richTextElementToMrkdwn).join('');
}

export function isRichTextContent(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return false;
  }

  try {
    const parsedValue = JSON.parse(value);
    return (
      Array.isArray(parsedValue) &&
      parsedValue.length > 0 &&
      parsedValue.every(
        (section) => section && typeof section.type === 'string' && section.type.startsWith('rich_text_'),
      )
    );
  } catch {
    return false;
  }
}

export function contentToMrkdwn(value) {
  if (!isRichTextContent(value)) {
    return typeof value === 'string' ? value : '';
  }

  try {
    const sections = JSON.parse(value);
    return sections.map(richTextSectionToMrkdwn).join('\n\n');
  } catch {
    return typeof value === 'string' ? value : '';
  }
}

export function toRichTextInitialValue(value) {
  let elements;
  if (isRichTextContent(value)) {
    elements = JSON.parse(value);
  } else {
    const text = trimOrEmpty(value);
    if (!text) {
      return undefined;
    }
    elements = [{ type: 'rich_text_section', elements: [{ type: 'text', text }] }];
  }

  return { type: 'rich_text', elements };
}

export function parseMessageLink(link) {
  const match = String(link || '').match(/\/archives\/([A-Z0-9]+)\/p([0-9]{13,18})/);
  if (!match) {
    return null;
  }
  const [, channel, digits] = match;
  if (digits.length < 7) {
    return null;
  }
  return { channel, ts: `${digits.slice(0, -6)}.${digits.slice(-6)}` };
}
