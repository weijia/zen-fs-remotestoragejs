<!-- Use this file to provide workspace-specific custom instructions to Copilot. For more details, visit https://code.visualstudio.com/docs/copilot/copilot-customization#_use-a-githubcopilotinstructionsmd-file -->

# zen-fs-remotestoragejs Project Instructions

This is a TypeScript project that implements a zen-fs backend using RemoteStorage.js for distributed file storage.

## Project Context

- **Purpose**: Provide a zen-fs filesystem backend that uses RemoteStorage.js for cloud storage
- **Key Technologies**: TypeScript, zen-fs, RemoteStorage.js, Vitest, ESLint, Prettier
- **Target Environment**: Browser and Node.js

## Code Style & Patterns

- Use TypeScript with strict type checking
- Follow the existing error handling patterns with custom error classes
- Implement async/await for all operations
- Use proper path normalization utilities
- Follow zen-fs FileSystem interface conventions
- Write comprehensive tests for all functionality

## Key Components

- `RemoteStorageFileSystem`: Main filesystem implementation
- `types.ts`: TypeScript interfaces and error classes  
- `utils.ts`: Path manipulation and data conversion utilities
- `index.ts`: Main export file

## Testing Guidelines

- Write unit tests for all public methods
- Mock RemoteStorage client for testing
- Test error conditions and edge cases
- Use Vitest for testing framework

## File Naming & Organization

- Use camelCase for file names except for main components (PascalCase)
- Group related functionality in appropriate modules
- Export everything needed through the main index file

## Error Handling

- Use custom error classes that extend RemoteStorageError
- Provide meaningful error messages with context
- Include status codes where appropriate
- Handle both sync and async errors properly
