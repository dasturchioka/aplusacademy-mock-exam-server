const { readFile } = require('fs/promises')
const path = require('path')

async function getStrictSystemPrompt(part) {
  const filePath = path.resolve(process.cwd(), 'prompts', `${part}-prompt.txt`)
  const content = await readFile(filePath, { encoding: 'utf-8' })
  return content.trim() // optional: trim trailing whitespace
}

module.exports = { getStrictSystemPrompt }