# Backend Setup Guide

## Quick Start

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Create .env File**
   
   Create a `.env` file in the `backend` directory with the following content:
   ```
   PORT=3001
   OPENAI_API_KEY=your_openai_api_key_here
   UPLOAD_DIR=./uploads
   ```
   
   Replace `your_openai_api_key_here` with your actual OpenAI API key.

3. **Run the Server**
   ```bash
   npm run dev
   ```

## Environment Variables

- `PORT`: Server port (default: 3001)
- `OPENAI_API_KEY`: Your OpenAI API key (required)
- `UPLOAD_DIR`: Directory to store uploaded files (default: ./uploads)

## Notes

- The `uploads` directory will be created automatically
- Make sure your OpenAI API key has access to the embeddings API
- The server uses the `text-embedding-ada-002` model for embeddings
