const Tesseract = require('tesseract.js')
const FormData = require('form-data')
const fs = require('fs')
const axios = require('axios')
const path = require('path')

// Install jsonrepair for JSON cleaning: npm install jsonrepair
let jsonrepair
try {
  const { jsonrepair: repair } = require('jsonrepair')
  jsonrepair = repair
} catch (error) {
  console.warn('⚠️ jsonrepair package not found. Install with: npm install jsonrepair')
  jsonrepair = null
}

/**
 * OCR Service abstraction layer
 * Supports both Tesseract.js and docTR with automatic fallback
 *
 * JSON Parsing Features:
 * - Robust JSON parsing with automatic cleaning and repair
 * - Handles common GPT-4 response formatting issues
 * - Multiple fallback strategies for parsing invalid JSON
 *
 * Usage Examples:
 *
 * // Simple JSON parsing with error handling
 * try {
 *   const result = OCRService.parseJsonSafely(gptResponse, 'GPT-4')
 *   console.log('Parsed:', result)
 * } catch (error) {
 *   console.error('Failed to parse JSON:', error.message)
 * }
 *
 * // Processing GPT responses with promises
 * const result = await OCRService.processGptJsonResponse(
 *   openai.chat.completions.create({...}),
 *   'Question Analysis'
 * )
 *
 * // Manual JSON cleaning
 * const cleaned = OCRService.cleanJsonString(rawJsonString)
 * const parsed = JSON.parse(cleaned)
 */
class OCRService {
  constructor(options = {}) {
    this.primaryService = options.primaryService || process.env.OCR_SERVICE || 'tesseract'
    this.fallbackService = options.fallbackService || 'tesseract'
    this.doctrUrl = options.doctrUrl || process.env.DOCTR_URL || 'http://localhost:8000'
    this.timeout = options.timeout || 30000 // 30 seconds
    this.maxRetries = options.maxRetries || 2

    console.log(`🔧 OCR Service initialized with primary: ${this.primaryService}, fallback: ${this.fallbackService}`)
  }

  /**
   * Health check for docTR service
   */
  async isDocTRHealthy() {
    try {
      const response = await axios.get(`${this.doctrUrl}/health`, {
        timeout: 5000
      })
      console.log(response);

      return response.status === 200 && response.data.status === 'healthy'
    } catch (error) {
      console.log(error);
      console.warn('⚠️ docTR service health check failed:', error.message)
      return false
    }
  }

  /**
   * Extract text using docTR service
   */
  async extractTextWithDocTR(imagePath) {
    try {
      const startTime = Date.now()

      // Check if file exists
      if (!fs.existsSync(imagePath)) {
        throw new Error(`Image file not found: ${imagePath}`)
      }

      // Prepare form data
      const formData = new FormData()
      formData.append('file', fs.createReadStream(imagePath))

      // Make request to docTR service
      console.log(`🔍 docTR: Processing ${path.basename(imagePath)}`)

      const response = await axios.post(`${this.doctrUrl}/ocr`, formData, {
        headers: {
          ...formData.getHeaders(),
          'Content-Type': 'multipart/form-data'
        },
        timeout: this.timeout,
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      })

      const processingTime = Date.now() - startTime

      if (response.data.success) {
        console.log(`✅ docTR: Extracted ${response.data.character_count} characters in ${processingTime}ms (confidence: ${response.data.confidence.toFixed(2)})`)

        return {
          text: response.data.text,
          confidence: response.data.confidence,
          processingTime,
          service: 'docTR',
          metadata: response.data.processing_info
        }
      } else {
        throw new Error('docTR service returned unsuccessful response')
      }

    } catch (error) {
      console.error(`❌ docTR extraction failed: ${error.message}`)
      throw error
    }
  }

  /**
   * Extract text using Tesseract.js
   */
  async extractTextWithTesseract(imagePath) {
    try {
      const startTime = Date.now()

      console.log(`🔍 Tesseract: Processing ${path.basename(imagePath)}`)

      const { data: { text, confidence } } = await Tesseract.recognize(imagePath, 'eng', {
        logger: m => {
          if (m.status === 'recognizing text') {
            console.log(`🧠 Tesseract progress: ${Math.floor(m.progress * 100)}%`)
          }
        }
      })

      const processingTime = Date.now() - startTime

      console.log(`✅ Tesseract: Extracted ${text.length} characters in ${processingTime}ms (confidence: ${confidence.toFixed(2)})`)

      return {
        text,
        confidence,
        processingTime,
        service: 'Tesseract',
        metadata: {
          model: 'Tesseract.js',
          filename: path.basename(imagePath),
          file_size: fs.statSync(imagePath).size
        }
      }

    } catch (error) {
      console.error(`❌ Tesseract extraction failed: ${error.message}`)
      throw error
    }
  }

  /**
   * Extract text with automatic service selection and fallback
   */
  async extractText(imagePath) {
    let lastError = null
    let attempts = 0

    // Try primary service first
    while (attempts < this.maxRetries) {
      attempts++

      try {
        if (this.primaryService === 'doctr') {
          // Check if docTR is healthy before attempting
          if (await this.isDocTRHealthy()) {
            return await this.extractTextWithDocTR(imagePath)
          } else {
            throw new Error('docTR service is unhealthy')
          }
        } else {
          return await this.extractTextWithTesseract(imagePath)
        }
      } catch (error) {
        lastError = error
        console.warn(`⚠️ OCR attempt ${attempts} failed with ${this.primaryService}: ${error.message}`)

        if (attempts < this.maxRetries) {
          console.log(`🔄 Retrying in 1 second...`)
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
      }
    }

    // If primary service failed, try fallback
    if (this.fallbackService !== this.primaryService) {
      console.log(`🔄 Falling back to ${this.fallbackService}`)

      try {
        if (this.fallbackService === 'doctr') {
          if (await this.isDocTRHealthy()) {
            return await this.extractTextWithDocTR(imagePath)
          } else {
            throw new Error('docTR fallback service is also unhealthy')
          }
        } else {
          return await this.extractTextWithTesseract(imagePath)
        }
      } catch (fallbackError) {
        console.error(`❌ Fallback service ${this.fallbackService} also failed: ${fallbackError.message}`)
        throw new Error(`Both primary (${this.primaryService}) and fallback (${this.fallbackService}) OCR services failed. Last error: ${lastError.message}`)
      }
    }

    throw lastError
  }

  /**
   * Extract text from multiple images in batch
   */
  async extractTextBatch(imagePaths) {
    const results = []

    for (let i = 0; i < imagePaths.length; i++) {
      const imagePath = imagePaths[i]

      try {
        console.log(`📄 Processing image ${i + 1}/${imagePaths.length}: ${path.basename(imagePath)}`)
        const result = await this.extractText(imagePath)
        results.push({
          index: i,
          imagePath,
          success: true,
          result
        })
      } catch (error) {
        console.error(`❌ Failed to process image ${i + 1}: ${error.message}`)
        results.push({
          index: i,
          imagePath,
          success: false,
          error: error.message
        })
      }
    }

    const successful = results.filter(r => r.success).length
    console.log(`✅ Batch processing complete: ${successful}/${imagePaths.length} images processed successfully`)

    return results
  }

  /**
   * Clean and fix JSON string to ensure it's valid
   * Handles common GPT-4 JSON formatting issues
   */
  static cleanJsonString(rawJsonString) {
    if (!rawJsonString || typeof rawJsonString !== 'string') {
      throw new Error('Invalid JSON string provided')
    }

    let cleaned = rawJsonString
      // Remove markdown code fences and json language hints
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')

      // Fix unquoted property names - handle common patterns
      .replace(/([,{]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":')
      .replace(/(^\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":')

      // Remove trailing commas
      .replace(/,\s*([}\]])/g, '$1')

      // Fix escaped quotes in strings - be careful not to break valid escaping
      .replace(/([^\\])\\"/g, '$1\\"')

      // Normalize line breaks in string values to \n
      .replace(/(".*?)"[\r\n]+/g, (match, content) => {
        return content.replace(/\r?\n/g, '\\n') + '"'
      })

      // Remove any control characters that might break JSON
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')

      // Trim whitespace
      .trim()

    return cleaned
  }

  /**
   * Parse JSON with automatic cleaning and repair fallbacks
   * Returns parsed object or throws descriptive error
   */
  static parseJsonSafely(rawJsonString, context = 'JSON') {
    if (!rawJsonString) {
      throw new Error(`Empty ${context} response received`)
    }

    // First attempt: try parsing as-is
    try {
      return JSON.parse(rawJsonString)
    } catch (initialError) {
      console.warn(`⚠️ Initial JSON parse failed for ${context}: ${initialError.message}`)
    }

    // Second attempt: clean the JSON string manually
    try {
      const cleaned = OCRService.cleanJsonString(rawJsonString)
      console.log(`🔧 Attempting to parse cleaned JSON for ${context}`)
      return JSON.parse(cleaned)
    } catch (cleanedError) {
      console.warn(`⚠️ Cleaned JSON parse failed for ${context}: ${cleanedError.message}`)
    }

    // Third attempt: use jsonrepair if available
    if (jsonrepair) {
      try {
        console.log(`🔧 Attempting JSON repair for ${context}`)
        const repaired = jsonrepair(rawJsonString)
        return JSON.parse(repaired)
      } catch (repairError) {
        console.warn(`⚠️ JSON repair failed for ${context}: ${repairError.message}`)
      }
    }

    // Final attempt: try to extract JSON from response if it's embedded
    const jsonMatch = rawJsonString.match(/\{.*\}/s)
    if (jsonMatch) {
      try {
        const extracted = jsonMatch[0]
        console.log(`🔧 Attempting to parse extracted JSON for ${context}`)
        return JSON.parse(OCRService.cleanJsonString(extracted))
      } catch (extractError) {
        console.warn(`⚠️ Extracted JSON parse failed for ${context}: ${extractError.message}`)
      }
    }

    // If all attempts fail, provide detailed error information
    const truncatedResponse = rawJsonString.length > 200
      ? rawJsonString.substring(0, 200) + '...'
      : rawJsonString

    throw new Error(`Failed to parse ${context} JSON after all repair attempts. Raw response: ${truncatedResponse}`)
  }

  /**
   * Utility method for processing GPT-4 responses with JSON cleaning
   * Use this when calling GPT-4 APIs that return JSON
   */
  static async processGptJsonResponse(gptResponsePromise, context = 'GPT-4') {
    try {
      const response = await gptResponsePromise
      const rawJson = typeof response === 'string' ? response : response.data || response.text || JSON.stringify(response)

      console.log(`📝 Processing ${context} response (${rawJson.length} characters)`)

      return OCRService.parseJsonSafely(rawJson, context)
    } catch (error) {
      console.error(`❌ Failed to process ${context} JSON response: ${error.message}`)
      throw error
    }
  }

  /**
   * Clean OCR text with enhanced IELTS-specific cleaning
   */
  static cleanOCRText(text) {
    return text
      // Remove page numbers, headers, and footers
      .replace(/Page\s*\d+/gi, '')
      .replace(/IELTS\s*\d+/gi, '')
      .replace(/Cambridge\s*IELTS/gi, '')
      .replace(/Test\s*\d+/gi, '')

      // Remove symbols like |, _, ——, or random pipes
      .replace(/\|/g, '')
      .replace(/_+/g, ' ')
      .replace(/——+/g, ' ')
      .replace(/\s*[|]\s*/g, ' ')

      // Fix broken numbering: ensure questions are 1. not l., I. or similar
      .replace(/(\d+)\s*\.\s*/g, '$1. ')
      .replace(/([lI])\s*\.\s*/g, '1. ')
      .replace(/O\s*\.\s*/g, '0. ')

      // Merge words that were split by OCR
      .replace(/([a-zA-Z])-\s*\n\s*([a-zA-Z])/g, '$1$2')
      .replace(/([a-zA-Z])-([a-zA-Z])/g, '$1$2')

      // Normalize line breaks — join broken sentences
      .replace(/\n(?=[a-z])/g, ' ')
      .replace(/\n+/g, ' ')

      // Fix spacing issues
      .replace(/\s+/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([0-9])([A-Z])/g, '$1 $2')
      .replace(/([a-zA-Z])([0-9])/g, '$1 $2')

      // Normalize dashes
      .replace(/\s*[-–—]\s*/g, ' - ')

      // Fix sentence spacing
      .replace(/([.?!])\s*([A-Z])/g, '$1 $2')

      // Remove multiple spaces and trim
      .replace(/\s+/g, ' ')
      .trim()
  }

  /**
   * Get service status and statistics
   */
  async getServiceStatus() {
    const doctrHealthy = await this.isDocTRHealthy()

    return {
      primaryService: this.primaryService,
      fallbackService: this.fallbackService,
      doctrUrl: this.doctrUrl,
      services: {
        docTR: {
          available: doctrHealthy,
          url: this.doctrUrl
        },
        tesseract: {
          available: true,
          version: 'tesseract.js 6.0.1'
        }
      },
      configuration: {
        timeout: this.timeout,
        maxRetries: this.maxRetries
      }
    }
  }
}

module.exports = OCRService