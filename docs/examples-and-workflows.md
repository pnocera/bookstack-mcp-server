# BookStack MCP Server - Examples and Workflows

This guide provides comprehensive examples and workflows for using the BookStack MCP Server effectively. Whether you're integrating with Claude, building automation scripts, or managing documentation at scale, these examples will help you get the most out of the system.

## Table of Contents

1. [Getting Started](#getting-started)
2. [Common Use Cases](#common-use-cases)
3. [Step-by-Step Workflows](#step-by-step-workflows)
4. [Integration Patterns](#integration-patterns)
5. [Best Practices](#best-practices)
6. [Real-World Scenarios](#real-world-scenarios)
7. [Advanced Patterns](#advanced-patterns)
8. [Troubleshooting](#troubleshooting)

## Getting Started

### Prerequisites

Before using these examples, ensure you have:
- BookStack instance running and accessible
- API token generated from BookStack
- BookStack MCP Server configured and running
- Claude Code or compatible MCP client

### Basic Configuration

```bash
# Install and configure
npm install -g bookstack-mcp-server

# Set up environment
export BOOKSTACK_BASE_URL="https://your-bookstack.example.com/api"
export BOOKSTACK_API_TOKEN="your-api-token-here"

# Test connection
bookstack-mcp-server --test-connection
```

## Common Use Cases

### 1. Documentation Management

#### Creating a New Documentation Project

**Scenario**: You need to create a new project documentation structure.

```javascript
// Step 1: Create the main project book
const projectBook = await tools.bookstack_books_create({
  name: "Project Alpha Documentation",
  description: "Complete documentation for Project Alpha",
  tags: [
    { name: "project", value: "alpha" },
    { name: "status", value: "active" },
    { name: "team", value: "engineering" }
  ]
});

// Step 2: Create chapters for organization
const chapters = await Promise.all([
  tools.bookstack_chapters_create({
    book_id: projectBook.id,
    name: "Getting Started",
    description: "Setup and installation guides",
    priority: 1
  }),
  tools.bookstack_chapters_create({
    book_id: projectBook.id,
    name: "API Reference",
    description: "Complete API documentation",
    priority: 2
  }),
  tools.bookstack_chapters_create({
    book_id: projectBook.id,
    name: "Examples",
    description: "Code examples and tutorials",
    priority: 3
  })
]);

// Step 3: Create initial pages
const pages = await Promise.all([
  tools.bookstack_pages_create({
    chapter_id: chapters[0].id,
    name: "Quick Start Guide",
    markdown: `# Quick Start Guide

## Installation

\`\`\`bash
npm install project-alpha
\`\`\`

## Configuration

...
`,
    tags: [{ name: "type", value: "guide" }]
  }),
  tools.bookstack_pages_create({
    chapter_id: chapters[1].id,
    name: "Authentication",
    markdown: `# Authentication

## API Keys

...
`,
    tags: [{ name: "type", value: "reference" }]
  })
]);
```

#### Bulk Content Import

**Scenario**: You have existing documentation to import.

```javascript
// Import from markdown files
const importDocumentation = async (bookId, markdownFiles) => {
  const results = [];
  
  for (const file of markdownFiles) {
    const content = await fs.readFile(file.path, 'utf8');
    const frontmatter = parseFrontmatter(content);
    
    const page = await tools.bookstack_pages_create({
      book_id: bookId,
      name: frontmatter.title || file.name,
      markdown: content,
      tags: frontmatter.tags || [],
      priority: frontmatter.priority || 0
    });
    
    results.push({
      file: file.path,
      page: page.id,
      status: 'imported'
    });
  }
  
  return results;
};

// Usage
const files = [
  { path: './docs/installation.md', name: 'Installation' },
  { path: './docs/configuration.md', name: 'Configuration' },
  { path: './docs/api-reference.md', name: 'API Reference' }
];

const importResults = await importDocumentation(projectBook.id, files);
```

### 2. Content Management

#### Automated Content Updates

**Scenario**: You need to update documentation based on code changes.

```javascript
// Update API documentation when code changes
const updateApiDocs = async (apiSpec) => {
  // Find existing API documentation
  const searchResults = await tools.bookstack_search({
    query: 'API Reference [page] tag:type=reference',
    count: 50
  });
  
  for (const result of searchResults.data) {
    if (result.type === 'page' && result.tags.includes('api')) {
      // Generate new content from API spec
      const newContent = generateApiDocs(apiSpec);
      
      // Update the page
      await tools.bookstack_pages_update({
        id: result.id,
        markdown: newContent,
        tags: [
          ...result.tags,
          { name: "last_updated", value: new Date().toISOString() },
          { name: "version", value: apiSpec.version }
        ]
      });
    }
  }
};

// Generate documentation from OpenAPI spec
const generateApiDocs = (spec) => {
  let markdown = `# API Reference v${spec.version}\n\n`;
  
  for (const [path, methods] of Object.entries(spec.paths)) {
    markdown += `## ${path}\n\n`;
    
    for (const [method, details] of Object.entries(methods)) {
      markdown += `### ${method.toUpperCase()} ${path}\n\n`;
      markdown += `${details.description}\n\n`;
      
      if (details.parameters) {
        markdown += `#### Parameters\n\n`;
        for (const param of details.parameters) {
          markdown += `- **${param.name}** (${param.in}): ${param.description}\n`;
        }
        markdown += `\n`;
      }
    }
  }
  
  return markdown;
};
```

#### Content Validation and Cleanup

**Scenario**: You need to maintain content quality across your documentation.

```javascript
// Validate and clean up documentation
const validateDocumentation = async () => {
  const validationResults = [];
  
  // Get all pages
  const pages = await tools.bookstack_pages_list({
    count: 500,
    sort: 'updated_at'
  });
  
  for (const page of pages.data) {
    const pageDetails = await tools.bookstack_pages_read({
      id: page.id
    });
    
    const validation = {
      id: page.id,
      name: page.name,
      issues: []
    };
    
    // Check for common issues
    if (!pageDetails.markdown || pageDetails.markdown.length < 100) {
      validation.issues.push('Content too short');
    }
    
    if (!pageDetails.tags || pageDetails.tags.length === 0) {
      validation.issues.push('No tags assigned');
    }
    
    if (pageDetails.markdown.includes('TODO') || pageDetails.markdown.includes('FIXME')) {
      validation.issues.push('Contains TODO/FIXME comments');
    }
    
    // Check for broken links
    const links = extractLinks(pageDetails.markdown);
    for (const link of links) {
      if (link.startsWith('http') && !(await isLinkValid(link))) {
        validation.issues.push(`Broken link: ${link}`);
      }
    }
    
    if (validation.issues.length > 0) {
      validationResults.push(validation);
    }
  }
  
  return validationResults;
};

// Fix common issues automatically
const autoFixIssues = async (validationResults) => {
  for (const page of validationResults) {
    const pageDetails = await tools.bookstack_pages_read({
      id: page.id
    });
    
    let needsUpdate = false;
    let updatedContent = pageDetails.markdown;
    let updatedTags = [...pageDetails.tags];
    
    // Auto-assign tags based on content
    if (updatedTags.length === 0) {
      const autoTags = generateAutoTags(pageDetails.markdown, pageDetails.name);
      updatedTags = [...updatedTags, ...autoTags];
      needsUpdate = true;
    }
    
    // Clean up common formatting issues
    updatedContent = cleanupMarkdown(updatedContent);
    if (updatedContent !== pageDetails.markdown) {
      needsUpdate = true;
    }
    
    if (needsUpdate) {
      await tools.bookstack_pages_update({
        id: page.id,
        markdown: updatedContent,
        tags: updatedTags
      });
    }
  }
};
```

### 3. Team Collaboration

#### Multi-User Workflow Setup

**Scenario**: Setting up a collaborative documentation workflow for a team.

```javascript
// Create team structure
const setupTeamWorkflow = async (teamConfig) => {
  // Create team roles
  const roles = await Promise.all([
    tools.bookstack_roles_create({
      display_name: "Documentation Editors",
      description: "Can create and edit documentation",
      permissions: {
        "content-export": true,
        "restrictions-manage-own": true
      }
    }),
    tools.bookstack_roles_create({
      display_name: "Documentation Reviewers",
      description: "Can review and approve documentation",
      permissions: {
        "content-export": true,
        "restrictions-manage-all": true
      }
    })
  ]);
  
  // Create team members
  const users = await Promise.all(teamConfig.members.map(member => 
    tools.bookstack_users_create({
      name: member.name,
      email: member.email,
      roles: [roles[member.role === 'reviewer' ? 1 : 0].id],
      send_invite: true
    })
  ));
  
  // Create team bookshelf
  const teamShelf = await tools.bookstack_shelves_create({
    name: `${teamConfig.name} Documentation`,
    description: `Documentation collection for ${teamConfig.name} team`,
    tags: [
      { name: "team", value: teamConfig.name.toLowerCase() },
      { name: "access", value: "team" }
    ]
  });
  
  // Set up permissions
  await tools.bookstack_permissions_update({
    content_type: 'bookshelf',
    content_id: teamShelf.id,
    permissions: users.map(user => ({
      user_id: user.id,
      view: true,
      create: true,
      update: user.roles.includes(roles[1].id), // Reviewers can update
      delete: false
    }))
  });
  
  return {
    roles,
    users,
    shelf: teamShelf
  };
};

// Usage
const teamSetup = await setupTeamWorkflow({
  name: "Engineering",
  members: [
    { name: "Alice Johnson", email: "alice@company.com", role: "editor" },
    { name: "Bob Smith", email: "bob@company.com", role: "reviewer" },
    { name: "Carol Davis", email: "carol@company.com", role: "editor" }
  ]
});
```

#### Review and Approval Workflow

**Scenario**: Implementing a review workflow for documentation changes.

```javascript
// Create review workflow
const createReviewWorkflow = async (pageId, reviewerIds) => {
  const page = await tools.bookstack_pages_read({ id: pageId });
  
  // Create review tracking tags
  const reviewTags = [
    { name: "status", value: "pending_review" },
    { name: "review_requested", value: new Date().toISOString() },
    { name: "reviewers", value: reviewerIds.join(",") }
  ];
  
  // Update page with review status
  await tools.bookstack_pages_update({
    id: pageId,
    tags: [...page.tags, ...reviewTags]
  });
  
  // Create review task pages
  const reviewTasks = await Promise.all(reviewerIds.map(async (reviewerId) => {
    const reviewer = await tools.bookstack_users_read({ id: reviewerId });
    
    return tools.bookstack_pages_create({
      book_id: page.book_id,
      name: `Review: ${page.name} (${reviewer.name})`,
      markdown: `# Review Task: ${page.name}

## Reviewer
${reviewer.name}

## Original Page
[${page.name}](${page.url})

## Review Checklist
- [ ] Content accuracy
- [ ] Grammar and style
- [ ] Completeness
- [ ] Links and references
- [ ] Code examples (if applicable)

## Comments
<!-- Add your review comments here -->

## Decision
<!-- Approve/Request Changes/Reject -->
`,
      tags: [
        { name: "type", value: "review_task" },
        { name: "target_page", value: pageId.toString() },
        { name: "reviewer", value: reviewerId.toString() },
        { name: "status", value: "pending" }
      ]
    });
  }));
  
  return {
    page,
    reviewTasks
  };
};

// Check review status
const checkReviewStatus = async (pageId) => {
  const reviewTasks = await tools.bookstack_search({
    query: `tag:type=review_task tag:target_page=${pageId}`,
    count: 20
  });
  
  const status = {
    total: reviewTasks.data.length,
    completed: 0,
    approved: 0,
    rejected: 0,
    pending: 0
  };
  
  for (const task of reviewTasks.data) {
    const taskDetails = await tools.bookstack_pages_read({ id: task.id });
    const statusTag = taskDetails.tags.find(t => t.name === 'status');
    
    if (statusTag) {
      switch (statusTag.value) {
        case 'approved':
          status.approved++;
          status.completed++;
          break;
        case 'rejected':
          status.rejected++;
          status.completed++;
          break;
        case 'changes_requested':
          status.completed++;
          break;
        default:
          status.pending++;
      }
    }
  }
  
  return status;
};
```

## Step-by-Step Workflows

### Workflow 1: Creating a Complete Knowledge Base

**Goal**: Set up a comprehensive knowledge base for a software project.

#### Step 1: Planning and Structure

```javascript
// Define the knowledge base structure
const knowledgeBaseStructure = {
  name: "Software Project KB",
  description: "Complete knowledge base for our software project",
  structure: {
    "Getting Started": {
      "Installation Guide": "markdown",
      "Quick Start": "markdown",
      "Configuration": "markdown"
    },
    "User Guide": {
      "Basic Usage": "markdown",
      "Advanced Features": "markdown",
      "Troubleshooting": "markdown"
    },
    "Developer Guide": {
      "Architecture": "markdown",
      "API Reference": "markdown",
      "Contributing": "markdown"
    },
    "Operations": {
      "Deployment": "markdown",
      "Monitoring": "markdown",
      "Backup & Recovery": "markdown"
    }
  }
};
```

#### Step 2: Implementation

```javascript
// Create the knowledge base
const createKnowledgeBase = async (structure) => {
  // Step 1: Create the main book
  const book = await tools.bookstack_books_create({
    name: structure.name,
    description: structure.description,
    tags: [
      { name: "type", value: "knowledge_base" },
      { name: "status", value: "active" },
      { name: "created", value: new Date().toISOString() }
    ]
  });
  
  // Step 2: Create chapters and pages
  const chapters = [];
  let chapterPriority = 1;
  
  for (const [chapterName, pages] of Object.entries(structure.structure)) {
    const chapter = await tools.bookstack_chapters_create({
      book_id: book.id,
      name: chapterName,
      description: `${chapterName} documentation`,
      priority: chapterPriority++
    });
    
    chapters.push(chapter);
    
    // Create pages within the chapter
    let pagePriority = 1;
    for (const [pageName, contentType] of Object.entries(pages)) {
      const page = await tools.bookstack_pages_create({
        chapter_id: chapter.id,
        name: pageName,
        markdown: generateTemplateContent(pageName, contentType),
        priority: pagePriority++,
        tags: [
          { name: "template", value: "true" },
          { name: "content_type", value: contentType }
        ]
      });
    }
  }
  
  // Step 3: Create a bookshelf to organize related books
  const shelf = await tools.bookstack_shelves_create({
    name: "Project Documentation",
    description: "All documentation for the project",
    books: [book.id],
    tags: [
      { name: "project", value: "main" },
      { name: "type", value: "documentation_collection" }
    ]
  });
  
  return {
    book,
    chapters,
    shelf
  };
};

// Generate template content for different content types
const generateTemplateContent = (pageName, contentType) => {
  const templates = {
    markdown: `# ${pageName}

## Overview
<!-- Brief description of what this page covers -->

## Content
<!-- Main content goes here -->

## See Also
<!-- Links to related pages -->

---
*Last updated: ${new Date().toISOString()}*
`,
    api: `# ${pageName}

## Endpoints

### GET /api/example
<!-- API endpoint documentation -->

**Parameters:**
- \`param1\` (string): Description

**Response:**
\`\`\`json
{
  "example": "response"
}
\`\`\`

## Examples

\`\`\`bash
curl -X GET /api/example
\`\`\`
`,
    guide: `# ${pageName}

## Prerequisites
<!-- What users need before following this guide -->

## Step-by-Step Instructions

### Step 1: Initial Setup
<!-- Detailed instructions -->

### Step 2: Configuration
<!-- More instructions -->

## Troubleshooting
<!-- Common issues and solutions -->

## Next Steps
<!-- What to do after completing this guide -->
`
  };
  
  return templates[contentType] || templates.markdown;
};
```

#### Step 3: Content Population

```javascript
// Populate the knowledge base with actual content
const populateKnowledgeBase = async (bookId, contentSources) => {
  const pages = await tools.bookstack_pages_list({
    filter: { book_id: bookId },
    count: 500
  });
  
  for (const page of pages.data) {
    const pageDetails = await tools.bookstack_pages_read({ id: page.id });
    
    // Skip if not a template
    if (!pageDetails.tags.find(t => t.name === 'template' && t.value === 'true')) {
      continue;
    }
    
    // Find matching content source
    const contentSource = contentSources.find(source => 
      source.pageName === page.name || 
      source.pageId === page.id
    );
    
    if (contentSource) {
      let newContent;
      
      if (contentSource.type === 'file') {
        newContent = await fs.readFile(contentSource.path, 'utf8');
      } else if (contentSource.type === 'generated') {
        newContent = await contentSource.generator();
      } else {
        newContent = contentSource.content;
      }
      
      // Update the page
      await tools.bookstack_pages_update({
        id: page.id,
        markdown: newContent,
        tags: pageDetails.tags.filter(t => t.name !== 'template')
      });
    }
  }
};

// Usage
const contentSources = [
  {
    pageName: "Installation Guide",
    type: "file",
    path: "./docs/installation.md"
  },
  {
    pageName: "API Reference",
    type: "generated",
    generator: () => generateApiDocs(apiSpec)
  },
  {
    pageName: "Quick Start",
    type: "content",
    content: "# Quick Start\n\nWelcome to our project..."
  }
];

await populateKnowledgeBase(book.id, contentSources);
```

### Workflow 2: Automated Documentation Sync

**Goal**: Keep documentation in sync with code changes using CI/CD integration.

#### Step 1: Setup CI/CD Integration

```javascript
// CI/CD script for documentation sync
const syncDocumentation = async (projectConfig) => {
  console.log('Starting documentation sync...');
  
  // Step 1: Analyze code changes
  const codeChanges = await analyzeCodeChanges();
  
  // Step 2: Identify affected documentation
  const affectedDocs = await identifyAffectedDocs(codeChanges);
  
  // Step 3: Update documentation
  const updateResults = [];
  
  for (const doc of affectedDocs) {
    try {
      const result = await updateDocumentation(doc, codeChanges);
      updateResults.push(result);
    } catch (error) {
      console.error(`Failed to update ${doc.name}:`, error);
      updateResults.push({ doc: doc.name, status: 'failed', error });
    }
  }
  
  // Step 4: Generate sync report
  const report = await generateSyncReport(updateResults);
  
  // Step 5: Create or update sync report page
  await createSyncReportPage(report);
  
  console.log('Documentation sync completed.');
  return report;
};

// Analyze code changes from git
const analyzeCodeChanges = async () => {
  const { execSync } = require('child_process');
  
  // Get changed files
  const changedFiles = execSync('git diff --name-only HEAD~1 HEAD')
    .toString()
    .trim()
    .split('\n')
    .filter(file => file);
  
  const changes = [];
  
  for (const file of changedFiles) {
    const diff = execSync(`git diff HEAD~1 HEAD -- ${file}`).toString();
    const fileExtension = file.split('.').pop();
    
    changes.push({
      file,
      type: fileExtension,
      diff,
      category: categorizeFile(file)
    });
  }
  
  return changes;
};

// Identify which documentation needs updates
const identifyAffectedDocs = async (codeChanges) => {
  const affectedDocs = [];
  
  // Search for documentation that might be affected
  for (const change of codeChanges) {
    const searchQueries = generateSearchQueries(change);
    
    for (const query of searchQueries) {
      const searchResults = await tools.bookstack_search({
        query,
        count: 10
      });
      
      for (const result of searchResults.data) {
        if (result.type === 'page') {
          affectedDocs.push({
            id: result.id,
            name: result.name,
            change,
            relevance: calculateRelevance(result, change)
          });
        }
      }
    }
  }
  
  // Remove duplicates and sort by relevance
  const uniqueDocs = Array.from(
    new Map(affectedDocs.map(doc => [doc.id, doc])).values()
  ).sort((a, b) => b.relevance - a.relevance);
  
  return uniqueDocs;
};

// Update documentation based on code changes
const updateDocumentation = async (doc, codeChanges) => {
  const pageDetails = await tools.bookstack_pages_read({ id: doc.id });
  
  let updatedContent = pageDetails.markdown;
  let hasChanges = false;
  
  // Apply automated updates based on change type
  for (const change of codeChanges) {
    if (change.category === 'api' && doc.name.includes('API')) {
      // Update API documentation
      const newApiContent = await generateApiUpdates(change);
      updatedContent = mergeApiContent(updatedContent, newApiContent);
      hasChanges = true;
    } else if (change.category === 'config' && doc.name.includes('Configuration')) {
      // Update configuration documentation
      const newConfigContent = await generateConfigUpdates(change);
      updatedContent = mergeConfigContent(updatedContent, newConfigContent);
      hasChanges = true;
    }
  }
  
  if (hasChanges) {
    // Add update metadata
    const updatedTags = [
      ...pageDetails.tags.filter(t => t.name !== 'last_sync'),
      { name: 'last_sync', value: new Date().toISOString() },
      { name: 'auto_updated', value: 'true' }
    ];
    
    await tools.bookstack_pages_update({
      id: doc.id,
      markdown: updatedContent,
      tags: updatedTags
    });
    
    return {
      doc: doc.name,
      status: 'updated',
      changes: codeChanges.length
    };
  }
  
  return {
    doc: doc.name,
    status: 'no_changes'
  };
};
```

#### Step 2: Automated Report Generation

```javascript
// Generate sync report page
const createSyncReportPage = async (report) => {
  const reportContent = `# Documentation Sync Report

**Date**: ${new Date().toISOString()}
**Status**: ${report.status}

## Summary
- **Total Documents Checked**: ${report.total}
- **Updated Documents**: ${report.updated}
- **Failed Updates**: ${report.failed}
- **No Changes**: ${report.noChanges}

## Updated Documents
${report.updates.map(update => `
### ${update.doc}
- **Status**: ${update.status}
- **Changes**: ${update.changes || 0}
${update.error ? `- **Error**: ${update.error}` : ''}
`).join('\n')}

## Code Changes Processed
${report.codeChanges.map(change => `
### ${change.file}
- **Type**: ${change.type}
- **Category**: ${change.category}
`).join('\n')}

---
*Generated automatically by CI/CD pipeline*
`;

  // Find or create sync reports book
  const syncBook = await findOrCreateSyncBook();
  
  // Create new report page
  await tools.bookstack_pages_create({
    book_id: syncBook.id,
    name: `Sync Report - ${new Date().toISOString().split('T')[0]}`,
    markdown: reportContent,
    tags: [
      { name: 'type', value: 'sync_report' },
      { name: 'date', value: new Date().toISOString().split('T')[0] },
      { name: 'status', value: report.status }
    ]
  });
};

const findOrCreateSyncBook = async () => {
  const searchResults = await tools.bookstack_search({
    query: 'tag:type=sync_reports',
    count: 1
  });
  
  if (searchResults.data.length > 0) {
    return searchResults.data[0];
  }
  
  // Create sync reports book
  return await tools.bookstack_books_create({
    name: 'Documentation Sync Reports',
    description: 'Automated documentation sync reports',
    tags: [
      { name: 'type', value: 'sync_reports' },
      { name: 'automated', value: 'true' }
    ]
  });
};
```

## Integration Patterns

### Pattern 1: Claude Code Integration

**Scenario**: Integrating BookStack MCP Server with Claude Code for enhanced documentation workflows.

#### Configuration

```json
{
  "mcpServers": {
    "bookstack": {
      "command": "npx",
      "args": ["bookstack-mcp-server"],
      "env": {
        "BOOKSTACK_BASE_URL": "https://docs.company.com/api",
        "BOOKSTACK_API_TOKEN": "your-token-here",
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

#### Usage Examples

```javascript
// Example 1: Research and Documentation
// Claude can now directly access your BookStack instance

// Search for existing documentation
const searchResults = await tools.bookstack_search({
  query: "authentication API [page]",
  count: 10
});

// Read existing content
const existingDoc = await tools.bookstack_pages_read({
  id: searchResults.data[0].id
});

// Update with new information
await tools.bookstack_pages_update({
  id: existingDoc.id,
  markdown: `${existingDoc.markdown}\n\n## New Section\n\nAdditional content...`
});
```

```javascript
// Example 2: Code Analysis and Documentation
// Claude can analyze code and create documentation

// After analyzing code files, Claude can create documentation
const apiDocs = await tools.bookstack_pages_create({
  book_id: 123,
  name: "User Management API",
  markdown: `# User Management API

Based on the code analysis, here are the available endpoints:

## POST /api/users
Creates a new user account.

**Parameters:**
- \`name\` (string): User's full name
- \`email\` (string): User's email address
- \`password\` (string): Password (minimum 8 characters)

**Response:**
\`\`\`json
{
  "id": 1,
  "name": "John Doe",
  "email": "john@example.com",
  "created_at": "2023-01-01T00:00:00Z"
}
\`\`\`

## GET /api/users/{id}
Retrieves user information.

...
`,
  tags: [
    { name: "type", value: "api_reference" },
    { name: "generated", value: "true" },
    { name: "version", value: "1.0" }
  ]
});
```

### Pattern 2: CI/CD Pipeline Integration

**Scenario**: Automatically update documentation as part of your deployment pipeline.

#### GitHub Actions Example

```yaml
name: Update Documentation

on:
  push:
    branches: [ main ]
  pull_request:
    branches: [ main ]

jobs:
  update-docs:
    runs-on: ubuntu-latest
    
    steps:
    - uses: actions/checkout@v2
    
    - name: Setup Node.js
      uses: actions/setup-node@v2
      with:
        node-version: '18'
    
    - name: Install dependencies
      run: |
        npm install -g bookstack-mcp-server
        npm install
    
    - name: Update API Documentation
      run: |
        node scripts/update-api-docs.js
      env:
        BOOKSTACK_BASE_URL: ${{ secrets.BOOKSTACK_BASE_URL }}
        BOOKSTACK_API_TOKEN: ${{ secrets.BOOKSTACK_API_TOKEN }}
    
    - name: Update Changelog
      run: |
        node scripts/update-changelog.js
      env:
        BOOKSTACK_BASE_URL: ${{ secrets.BOOKSTACK_BASE_URL }}
        BOOKSTACK_API_TOKEN: ${{ secrets.BOOKSTACK_API_TOKEN }}
```

#### Documentation Update Script

```javascript
// scripts/update-api-docs.js
const { BookStackMCPServer } = require('bookstack-mcp-server');

const updateApiDocs = async () => {
  const server = new BookStackMCPServer({
    baseUrl: process.env.BOOKSTACK_BASE_URL,
    apiToken: process.env.BOOKSTACK_API_TOKEN
  });
  
  // Generate OpenAPI documentation
  const openApiSpec = await generateOpenApiSpec();
  
  // Find API documentation page
  const searchResults = await server.search({
    query: 'API Documentation [page] tag:type=api_reference',
    count: 1
  });
  
  if (searchResults.data.length > 0) {
    const apiPage = searchResults.data[0];
    
    // Generate new documentation content
    const newContent = generateApiMarkdown(openApiSpec);
    
    // Update the page
    await server.updatePage({
      id: apiPage.id,
      markdown: newContent,
      tags: [
        { name: 'type', value: 'api_reference' },
        { name: 'last_updated', value: new Date().toISOString() },
        { name: 'version', value: openApiSpec.version }
      ]
    });
    
    console.log('API documentation updated successfully');
  } else {
    console.log('API documentation page not found');
  }
};

updateApiDocs().catch(console.error);
```

### Pattern 3: Multi-Environment Documentation

**Scenario**: Managing documentation across different environments (dev, staging, prod).

#### Environment-Specific Configuration

```javascript
// config/environments.js
const environments = {
  development: {
    bookstack: {
      baseUrl: 'http://localhost:8080/api',
      apiToken: process.env.DEV_BOOKSTACK_TOKEN
    },
    prefix: '[DEV]'
  },
  staging: {
    bookstack: {
      baseUrl: 'https://staging-docs.company.com/api',
      apiToken: process.env.STAGING_BOOKSTACK_TOKEN
    },
    prefix: '[STAGING]'
  },
  production: {
    bookstack: {
      baseUrl: 'https://docs.company.com/api',
      apiToken: process.env.PROD_BOOKSTACK_TOKEN
    },
    prefix: ''
  }
};

module.exports = environments;
```

#### Cross-Environment Sync

```javascript
// scripts/sync-environments.js
const syncEnvironments = async (sourceEnv, targetEnv) => {
  const sourceServer = new BookStackMCPServer(environments[sourceEnv].bookstack);
  const targetServer = new BookStackMCPServer(environments[targetEnv].bookstack);
  
  // Get all pages from source
  const sourcePages = await sourceServer.listPages({
    count: 500,
    filter: { tag: 'sync_enabled=true' }
  });
  
  for (const sourcePage of sourcePages.data) {
    const pageDetails = await sourceServer.readPage({ id: sourcePage.id });
    
    // Find corresponding page in target environment
    const targetSearch = await targetServer.search({
      query: `name:"${pageDetails.name}" tag:source_id=${pageDetails.id}`,
      count: 1
    });
    
    if (targetSearch.data.length > 0) {
      // Update existing page
      await targetServer.updatePage({
        id: targetSearch.data[0].id,
        markdown: pageDetails.markdown,
        tags: [
          ...pageDetails.tags,
          { name: 'synced_from', value: sourceEnv },
          { name: 'synced_at', value: new Date().toISOString() }
        ]
      });
    } else {
      // Create new page
      await targetServer.createPage({
        book_id: getTargetBookId(pageDetails.book_id, targetEnv),
        name: `${environments[targetEnv].prefix}${pageDetails.name}`,
        markdown: pageDetails.markdown,
        tags: [
          ...pageDetails.tags,
          { name: 'source_id', value: pageDetails.id.toString() },
          { name: 'synced_from', value: sourceEnv },
          { name: 'synced_at', value: new Date().toISOString() }
        ]
      });
    }
  }
};
```

## Best Practices

### 1. Content Organization

#### Hierarchical Structure
```
Project Documentation
├── Getting Started (Book)
│   ├── Installation (Chapter)
│   │   ├── Prerequisites (Page)
│   │   ├── Installation Guide (Page)
│   │   └── Troubleshooting (Page)
│   └── Quick Start (Chapter)
│       ├── First Steps (Page)
│       └── Basic Configuration (Page)
├── User Guide (Book)
│   ├── Core Features (Chapter)
│   └── Advanced Usage (Chapter)
└── Developer Guide (Book)
    ├── API Reference (Chapter)
    └── Contributing (Chapter)
```

#### Tagging Strategy
```javascript
// Consistent tagging for better organization
const tagStrategies = {
  content_type: ['guide', 'reference', 'tutorial', 'faq'],
  audience: ['beginner', 'intermediate', 'advanced'],
  status: ['draft', 'review', 'published', 'archived'],
  priority: ['high', 'medium', 'low'],
  topic: ['api', 'ui', 'database', 'deployment'],
  version: ['1.0', '2.0', 'latest']
};

// Apply tags consistently
const createPageWithTags = async (pageData) => {
  const standardTags = [
    { name: 'created_at', value: new Date().toISOString() },
    { name: 'author', value: pageData.author },
    { name: 'content_type', value: pageData.contentType },
    { name: 'status', value: 'draft' }
  ];
  
  return await tools.bookstack_pages_create({
    ...pageData,
    tags: [...standardTags, ...(pageData.tags || [])]
  });
};
```

### 2. Version Control Integration

#### Documentation Versioning
```javascript
// Create versioned documentation
const createVersionedDocs = async (version, sourceBookId) => {
  const sourceBook = await tools.bookstack_books_read({ id: sourceBookId });
  
  // Create new version book
  const versionBook = await tools.bookstack_books_create({
    name: `${sourceBook.name} v${version}`,
    description: `Version ${version} of ${sourceBook.name}`,
    tags: [
      { name: 'version', value: version },
      { name: 'source_book', value: sourceBookId.toString() },
      { name: 'created_at', value: new Date().toISOString() }
    ]
  });
  
  // Copy all chapters and pages
  for (const chapter of sourceBook.contents) {
    const newChapter = await tools.bookstack_chapters_create({
      book_id: versionBook.id,
      name: chapter.name,
      description: chapter.description,
      priority: chapter.priority
    });
    
    for (const page of chapter.pages) {
      const pageDetails = await tools.bookstack_pages_read({ id: page.id });
      
      await tools.bookstack_pages_create({
        chapter_id: newChapter.id,
        name: pageDetails.name,
        markdown: pageDetails.markdown,
        tags: [
          ...pageDetails.tags,
          { name: 'version', value: version }
        ]
      });
    }
  }
  
  return versionBook;
};
```

### 3. Performance Optimization

#### Batch Operations
```javascript
// Efficient batch operations
const batchUpdatePages = async (updates) => {
  const batchSize = 10;
  const results = [];
  
  for (let i = 0; i < updates.length; i += batchSize) {
    const batch = updates.slice(i, i + batchSize);
    
    const batchResults = await Promise.all(
      batch.map(async (update) => {
        try {
          const result = await tools.bookstack_pages_update(update);
          return { success: true, result };
        } catch (error) {
          return { success: false, error: error.message };
        }
      })
    );
    
    results.push(...batchResults);
    
    // Add delay between batches to avoid rate limiting
    if (i + batchSize < updates.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  return results;
};
```

#### Caching Strategy
```javascript
// Implement caching for frequently accessed content
class BookStackCache {
  constructor() {
    this.cache = new Map();
    this.ttl = 5 * 60 * 1000; // 5 minutes
  }
  
  async getPage(pageId) {
    const cacheKey = `page:${pageId}`;
    const cached = this.cache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.ttl) {
      return cached.data;
    }
    
    const page = await tools.bookstack_pages_read({ id: pageId });
    this.cache.set(cacheKey, {
      data: page,
      timestamp: Date.now()
    });
    
    return page;
  }
  
  invalidate(pageId) {
    this.cache.delete(`page:${pageId}`);
  }
}
```

### 4. Error Handling and Resilience

#### Robust Error Handling
```javascript
// Comprehensive error handling
const robustPageUpdate = async (pageId, updates, retries = 3) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await tools.bookstack_pages_update({
        id: pageId,
        ...updates
      });
      
      return { success: true, result };
    } catch (error) {
      console.error(`Attempt ${attempt} failed:`, error.message);
      
      if (attempt === retries) {
        return { 
          success: false, 
          error: error.message,
          pageId 
        };
      }
      
      // Exponential backoff
      const delay = Math.pow(2, attempt) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
};

// Bulk operation with error handling
const bulkUpdateWithErrorHandling = async (updates) => {
  const results = {
    successful: [],
    failed: []
  };
  
  for (const update of updates) {
    const result = await robustPageUpdate(update.id, update.data);
    
    if (result.success) {
      results.successful.push(result.result);
    } else {
      results.failed.push(result);
    }
  }
  
  // Generate error report if there are failures
  if (results.failed.length > 0) {
    await generateErrorReport(results.failed);
  }
  
  return results;
};
```

## Real-World Scenarios

### Scenario 1: API Documentation Automation

**Challenge**: Keeping API documentation synchronized with code changes in a fast-moving development environment.

**Solution**: Automated pipeline that extracts API information from code and updates documentation.

```javascript
// Complete API documentation automation
const automateApiDocumentation = async () => {
  // Step 1: Extract API information from code
  const apiInfo = await extractApiInfo();
  
  // Step 2: Generate documentation content
  const docContent = await generateApiDocs(apiInfo);
  
  // Step 3: Update or create documentation pages
  await updateApiDocumentation(docContent);
  
  // Step 4: Create change log
  await createChangeLog(apiInfo);
  
  // Step 5: Notify stakeholders
  await notifyStakeholders();
};

const extractApiInfo = async () => {
  // Extract from OpenAPI spec, code annotations, etc.
  const fs = require('fs');
  const path = require('path');
  
  const apiRoutes = [];
  const routeFiles = fs.readdirSync('./src/routes');
  
  for (const file of routeFiles) {
    if (file.endsWith('.js') || file.endsWith('.ts')) {
      const content = fs.readFileSync(path.join('./src/routes', file), 'utf8');
      const routes = parseRoutes(content);
      apiRoutes.push(...routes);
    }
  }
  
  return {
    routes: apiRoutes,
    version: process.env.API_VERSION || '1.0.0',
    baseUrl: process.env.API_BASE_URL || 'https://api.example.com'
  };
};

const generateApiDocs = async (apiInfo) => {
  let content = `# API Documentation v${apiInfo.version}

Base URL: \`${apiInfo.baseUrl}\`

## Authentication
All API endpoints require authentication using Bearer tokens.

\`\`\`
Authorization: Bearer YOUR_API_TOKEN
\`\`\`

## Endpoints

`;

  for (const route of apiInfo.routes) {
    content += `### ${route.method.toUpperCase()} ${route.path}

${route.description}

`;

    if (route.parameters && route.parameters.length > 0) {
      content += `**Parameters:**
`;
      for (const param of route.parameters) {
        content += `- \`${param.name}\` (${param.type}${param.required ? ', required' : ''}): ${param.description}
`;
      }
      content += `
`;
    }

    if (route.requestBody) {
      content += `**Request Body:**
\`\`\`json
${JSON.stringify(route.requestBody, null, 2)}
\`\`\`

`;
    }

    if (route.responses) {
      content += `**Responses:**
`;
      for (const [code, response] of Object.entries(route.responses)) {
        content += `
**${code}**: ${response.description}
\`\`\`json
${JSON.stringify(response.example, null, 2)}
\`\`\`

`;
      }
    }

    content += `---

`;
  }

  return content;
};

const updateApiDocumentation = async (docContent) => {
  // Find or create API documentation book
  const apiBook = await findOrCreateApiBook();
  
  // Update main API reference page
  const apiPages = await tools.bookstack_pages_list({
    filter: { book_id: apiBook.id },
    count: 100
  });
  
  let apiRefPage = apiPages.data.find(p => p.name === 'API Reference');
  
  if (apiRefPage) {
    await tools.bookstack_pages_update({
      id: apiRefPage.id,
      markdown: docContent,
      tags: [
        { name: 'type', value: 'api_reference' },
        { name: 'last_updated', value: new Date().toISOString() },
        { name: 'auto_generated', value: 'true' }
      ]
    });
  } else {
    apiRefPage = await tools.bookstack_pages_create({
      book_id: apiBook.id,
      name: 'API Reference',
      markdown: docContent,
      tags: [
        { name: 'type', value: 'api_reference' },
        { name: 'auto_generated', value: 'true' }
      ]
    });
  }
  
  return apiRefPage;
};
```

### Scenario 2: Multi-Language Documentation

**Challenge**: Managing documentation in multiple languages with consistent structure and content.

**Solution**: Automated translation workflow with version control.

```javascript
// Multi-language documentation management
const manageMultiLanguageDocs = async (sourceLanguage, targetLanguages) => {
  const sourceBook = await findDocumentationBook(sourceLanguage);
  
  for (const targetLang of targetLanguages) {
    await syncLanguageVersion(sourceBook, targetLang);
  }
};

const syncLanguageVersion = async (sourceBook, targetLanguage) => {
  // Find or create target language book
  const targetBook = await findOrCreateLanguageBook(sourceBook, targetLanguage);
  
  // Get all pages from source
  const sourcePages = await getAllPagesFromBook(sourceBook.id);
  
  for (const sourcePage of sourcePages) {
    const pageDetails = await tools.bookstack_pages_read({ id: sourcePage.id });
    
    // Check if translation exists
    const translationExists = await findTranslationPage(
      pageDetails.id, 
      targetLanguage
    );
    
    if (!translationExists || needsTranslationUpdate(pageDetails, translationExists)) {
      // Translate content
      const translatedContent = await translateContent(
        pageDetails.markdown,
        targetLanguage
      );
      
      if (translationExists) {
        // Update existing translation
        await tools.bookstack_pages_update({
          id: translationExists.id,
          markdown: translatedContent,
          tags: [
            ...translationExists.tags,
            { name: 'translated_at', value: new Date().toISOString() },
            { name: 'source_version', value: getPageVersion(pageDetails) }
          ]
        });
      } else {
        // Create new translation
        await tools.bookstack_pages_create({
          book_id: targetBook.id,
          name: pageDetails.name,
          markdown: translatedContent,
          tags: [
            { name: 'language', value: targetLanguage },
            { name: 'source_page', value: pageDetails.id.toString() },
            { name: 'translated_at', value: new Date().toISOString() }
          ]
        });
      }
    }
  }
};

const translateContent = async (content, targetLanguage) => {
  // This could integrate with translation services like Google Translate,
  // DeepL, or human translation workflows
  
  // Example using a translation service
  const translationService = getTranslationService();
  
  // Extract translatable content (preserving markdown structure)
  const sections = extractTranslatableSections(content);
  
  const translatedSections = await Promise.all(
    sections.map(section => 
      translationService.translate(section.text, targetLanguage)
    )
  );
  
  // Reconstruct markdown with translated content
  return reconstructMarkdown(sections, translatedSections);
};
```

### Scenario 3: Documentation Quality Assurance

**Challenge**: Ensuring documentation quality and consistency across a large team.

**Solution**: Automated quality checks and review workflows.

```javascript
// Documentation quality assurance system
const runQualityAssurance = async () => {
  const qualityReport = {
    timestamp: new Date().toISOString(),
    checks: [],
    issues: [],
    recommendations: []
  };
  
  // Get all documentation
  const allPages = await tools.bookstack_pages_list({
    count: 1000
  });
  
  for (const page of allPages.data) {
    const pageDetails = await tools.bookstack_pages_read({ id: page.id });
    const checks = await runPageQualityChecks(pageDetails);
    
    if (checks.issues.length > 0) {
      qualityReport.issues.push({
        page: page.name,
        id: page.id,
        issues: checks.issues
      });
    }
    
    qualityReport.checks.push({
      page: page.name,
      score: checks.score,
      passed: checks.passed,
      total: checks.total
    });
  }
  
  // Generate quality report
  await generateQualityReport(qualityReport);
  
  // Auto-fix issues where possible
  await autoFixIssues(qualityReport.issues);
  
  return qualityReport;
};

const runPageQualityChecks = async (page) => {
  const checks = {
    score: 0,
    passed: 0,
    total: 0,
    issues: []
  };
  
  // Check 1: Content length
  checks.total++;
  if (page.markdown.length > 100) {
    checks.passed++;
    checks.score += 10;
  } else {
    checks.issues.push({
      type: 'content_length',
      severity: 'medium',
      message: 'Page content is too short'
    });
  }
  
  // Check 2: Headings structure
  checks.total++;
  const headings = extractHeadings(page.markdown);
  if (hasProperHeadingStructure(headings)) {
    checks.passed++;
    checks.score += 15;
  } else {
    checks.issues.push({
      type: 'heading_structure',
      severity: 'low',
      message: 'Improper heading hierarchy'
    });
  }
  
  // Check 3: Links validation
  checks.total++;
  const links = extractLinks(page.markdown);
  const brokenLinks = await checkLinks(links);
  if (brokenLinks.length === 0) {
    checks.passed++;
    checks.score += 20;
  } else {
    checks.issues.push({
      type: 'broken_links',
      severity: 'high',
      message: `${brokenLinks.length} broken links found`,
      details: brokenLinks
    });
  }
  
  // Check 4: Tags presence
  checks.total++;
  if (page.tags && page.tags.length > 0) {
    checks.passed++;
    checks.score += 5;
  } else {
    checks.issues.push({
      type: 'missing_tags',
      severity: 'low',
      message: 'Page has no tags'
    });
  }
  
  // Check 5: Code blocks formatting
  checks.total++;
  const codeBlocks = extractCodeBlocks(page.markdown);
  if (areCodeBlocksProperlyFormatted(codeBlocks)) {
    checks.passed++;
    checks.score += 10;
  } else {
    checks.issues.push({
      type: 'code_formatting',
      severity: 'medium',
      message: 'Code blocks are not properly formatted'
    });
  }
  
  return checks;
};
```

## Advanced Patterns

### Pattern 1: Dynamic Content Generation

**Use Case**: Generate documentation from multiple sources (databases, APIs, configuration files).

```javascript
// Dynamic documentation generation
const generateDynamicDocs = async (sources) => {
  const generatedContent = {};
  
  for (const source of sources) {
    switch (source.type) {
      case 'database':
        generatedContent[source.name] = await generateDatabaseDocs(source);
        break;
      case 'api':
        generatedContent[source.name] = await generateApiDocs(source);
        break;
      case 'config':
        generatedContent[source.name] = await generateConfigDocs(source);
        break;
      default:
        console.warn(`Unknown source type: ${source.type}`);
    }
  }
  
  // Combine and structure content
  const combinedDocs = await combineGeneratedContent(generatedContent);
  
  // Update documentation pages
  await updateDynamicDocumentation(combinedDocs);
  
  return combinedDocs;
};

const generateDatabaseDocs = async (source) => {
  // Connect to database and extract schema information
  const db = await connectToDatabase(source.connection);
  const schema = await db.getSchema();
  
  let content = `# Database Schema Documentation

## Tables

`;

  for (const table of schema.tables) {
    content += `### ${table.name}

${table.description || 'No description available'}

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
`;
    
    for (const column of table.columns) {
      content += `| ${column.name} | ${column.type} | ${column.constraints || ''} | ${column.description || ''} |
`;
    }
    
    content += `

`;
  }
  
  return content;
};

const generateConfigDocs = async (source) => {
  // Read configuration files and generate documentation
  const config = await readConfigFiles(source.paths);
  
  let content = `# Configuration Documentation

## Environment Variables

`;

  for (const [key, value] of Object.entries(config.env)) {
    content += `### ${key}

- **Type**: ${value.type}
- **Required**: ${value.required ? 'Yes' : 'No'}
- **Default**: ${value.default || 'None'}
- **Description**: ${value.description}

`;
  }
  
  return content;
};
```

### Pattern 2: Collaborative Review System

**Use Case**: Implement a structured review process for documentation changes.

```javascript
// Collaborative review system
const implementReviewSystem = async () => {
  // Create review workflow templates
  await createReviewTemplates();
  
  // Set up review automation
  await setupReviewAutomation();
  
  // Create review dashboard
  await createReviewDashboard();
};

const createReviewTemplates = async () => {
  const templates = [
    {
      name: 'Technical Review Template',
      content: `# Technical Review: {{PAGE_NAME}}

## Review Checklist

### Technical Accuracy
- [ ] Code examples are correct and tested
- [ ] Technical concepts are accurately explained
- [ ] Links to external resources are valid

### Completeness
- [ ] All necessary information is included
- [ ] Prerequisites are clearly stated
- [ ] Examples cover common use cases

### Clarity
- [ ] Language is clear and concise
- [ ] Structure is logical and easy to follow
- [ ] Terminology is consistent

## Comments
<!-- Add your detailed comments here -->

## Decision
- [ ] Approve
- [ ] Request changes
- [ ] Reject

## Changes Requested
<!-- List specific changes needed -->
`
    },
    {
      name: 'Editorial Review Template',
      content: `# Editorial Review: {{PAGE_NAME}}

## Review Checklist

### Grammar and Style
- [ ] No grammatical errors
- [ ] Consistent tone and style
- [ ] Proper capitalization and punctuation

### Content Organization
- [ ] Information is well-organized
- [ ] Headings are descriptive
- [ ] Content flows logically

### Accessibility
- [ ] Content is accessible to target audience
- [ ] Technical jargon is explained
- [ ] Examples are relevant

## Comments
<!-- Add your detailed comments here -->

## Decision
- [ ] Approve
- [ ] Request changes
- [ ] Reject
`
    }
  ];
  
  // Create template book
  const templateBook = await tools.bookstack_books_create({
    name: 'Review Templates',
    description: 'Templates for documentation reviews',
    tags: [{ name: 'type', value: 'templates' }]
  });
  
  // Create template pages
  for (const template of templates) {
    await tools.bookstack_pages_create({
      book_id: templateBook.id,
      name: template.name,
      markdown: template.content,
      tags: [
        { name: 'type', value: 'review_template' },
        { name: 'template_name', value: template.name.toLowerCase().replace(/\s+/g, '_') }
      ]
    });
  }
};

const setupReviewAutomation = async () => {
  // Set up webhook or scheduled task to monitor page changes
  // This would integrate with your CI/CD or monitoring system
  
  const checkForReviewRequests = async () => {
    // Find pages that need review
    const pagesNeedingReview = await tools.bookstack_search({
      query: 'tag:status=needs_review',
      count: 50
    });
    
    for (const page of pagesNeedingReview.data) {
      await createReviewTask(page);
    }
  };
  
  // Schedule to run every hour
  setInterval(checkForReviewRequests, 60 * 60 * 1000);
};

const createReviewTask = async (page) => {
  const pageDetails = await tools.bookstack_pages_read({ id: page.id });
  
  // Get reviewers from page tags or default reviewers
  const reviewers = getReviewersForPage(pageDetails);
  
  for (const reviewer of reviewers) {
    // Create review task page
    const reviewTask = await tools.bookstack_pages_create({
      book_id: pageDetails.book_id,
      name: `Review Task: ${pageDetails.name} (${reviewer.name})`,
      markdown: generateReviewTask(pageDetails, reviewer),
      tags: [
        { name: 'type', value: 'review_task' },
        { name: 'target_page', value: page.id.toString() },
        { name: 'reviewer', value: reviewer.id.toString() },
        { name: 'status', value: 'pending' },
        { name: 'created_at', value: new Date().toISOString() }
      ]
    });
    
    // Notify reviewer (email, Slack, etc.)
    await notifyReviewer(reviewer, reviewTask, pageDetails);
  }
};
```

### Pattern 3: Analytics and Insights

**Use Case**: Track documentation usage and identify improvement opportunities.

```javascript
// Documentation analytics system
const implementAnalytics = async () => {
  // Set up tracking
  await setupAnalyticsTracking();
  
  // Generate insights
  const insights = await generateDocumentationInsights();
  
  // Create analytics dashboard
  await createAnalyticsDashboard(insights);
  
  return insights;
};

const generateDocumentationInsights = async () => {
  const insights = {
    overview: {},
    popularContent: [],
    underperformingContent: [],
    contentGaps: [],
    userBehavior: {},
    recommendations: []
  };
  
  // Get all pages with metadata
  const allPages = await tools.bookstack_pages_list({ count: 1000 });
  
  // Analyze content performance
  for (const page of allPages.data) {
    const pageDetails = await tools.bookstack_pages_read({ id: page.id });
    const analytics = await getPageAnalytics(page.id);
    
    const pageInsight = {
      id: page.id,
      name: page.name,
      views: analytics.views,
      timeOnPage: analytics.timeOnPage,
      bounceRate: analytics.bounceRate,
      lastUpdated: page.updated_at,
      wordCount: countWords(pageDetails.markdown),
      readingTime: calculateReadingTime(pageDetails.markdown)
    };
    
    // Categorize content
    if (analytics.views > 1000) {
      insights.popularContent.push(pageInsight);
    } else if (analytics.views < 10 && 
               Date.now() - new Date(page.created_at) > 30 * 24 * 60 * 60 * 1000) {
      insights.underperformingContent.push(pageInsight);
    }
  }
  
  // Generate recommendations
  insights.recommendations = await generateRecommendations(insights);
  
  return insights;
};

const generateRecommendations = async (insights) => {
  const recommendations = [];
  
  // Recommendation 1: Update stale content
  const staleContent = insights.underperformingContent.filter(page => {
    const daysSinceUpdate = (Date.now() - new Date(page.lastUpdated)) / (24 * 60 * 60 * 1000);
    return daysSinceUpdate > 90;
  });
  
  if (staleContent.length > 0) {
    recommendations.push({
      type: 'content_update',
      priority: 'high',
      description: `${staleContent.length} pages haven't been updated in 90+ days`,
      pages: staleContent.map(p => ({ id: p.id, name: p.name })),
      action: 'Review and update content'
    });
  }
  
  // Recommendation 2: Optimize popular content
  const popularContent = insights.popularContent.filter(page => page.bounceRate > 0.7);
  
  if (popularContent.length > 0) {
    recommendations.push({
      type: 'content_optimization',
      priority: 'medium',
      description: `${popularContent.length} popular pages have high bounce rates`,
      pages: popularContent.map(p => ({ id: p.id, name: p.name })),
      action: 'Improve content structure and add navigation'
    });
  }
  
  // Recommendation 3: Content gaps
  const searchQueries = await getFailedSearchQueries();
  if (searchQueries.length > 0) {
    recommendations.push({
      type: 'content_gaps',
      priority: 'medium',
      description: 'Users are searching for content that doesn\'t exist',
      queries: searchQueries.slice(0, 10),
      action: 'Create content for popular missing topics'
    });
  }
  
  return recommendations;
};

const createAnalyticsDashboard = async (insights) => {
  const dashboardContent = `# Documentation Analytics Dashboard

*Last updated: ${new Date().toISOString()}*

## Overview

- **Total Pages**: ${insights.overview.totalPages}
- **Total Views**: ${insights.overview.totalViews}
- **Average Reading Time**: ${insights.overview.averageReadingTime} minutes
- **Most Active Period**: ${insights.overview.mostActivePeriod}

## Popular Content

${insights.popularContent.slice(0, 10).map(page => `
### ${page.name}
- **Views**: ${page.views}
- **Time on Page**: ${page.timeOnPage} minutes
- **Bounce Rate**: ${Math.round(page.bounceRate * 100)}%
`).join('')}

## Recommendations

${insights.recommendations.map(rec => `
### ${rec.type.replace('_', ' ').toUpperCase()}
**Priority**: ${rec.priority.toUpperCase()}

${rec.description}

**Action**: ${rec.action}

${rec.pages ? `**Affected Pages**: ${rec.pages.length}` : ''}
`).join('')}

## Content Performance Matrix

| Content Type | Avg Views | Avg Time | Bounce Rate |
|-------------|-----------|----------|-------------|
${insights.contentTypes.map(type => `| ${type.name} | ${type.avgViews} | ${type.avgTime}min | ${Math.round(type.bounceRate * 100)}% |`).join('\n')}

---

*This dashboard is automatically generated based on documentation analytics.*
`;

  // Create or update dashboard page
  const dashboardSearch = await tools.bookstack_search({
    query: 'Analytics Dashboard tag:type=analytics',
    count: 1
  });
  
  if (dashboardSearch.data.length > 0) {
    await tools.bookstack_pages_update({
      id: dashboardSearch.data[0].id,
      markdown: dashboardContent
    });
  } else {
    const analyticsBook = await findOrCreateAnalyticsBook();
    await tools.bookstack_pages_create({
      book_id: analyticsBook.id,
      name: 'Analytics Dashboard',
      markdown: dashboardContent,
      tags: [
        { name: 'type', value: 'analytics' },
        { name: 'auto_generated', value: 'true' }
      ]
    });
  }
};
```

## Troubleshooting

### Common Issues and Solutions

#### 1. Authentication Problems

**Issue**: API calls failing with 401 Unauthorized

**Solutions**:
```javascript
// Check token validity
const validateToken = async () => {
  try {
    const systemInfo = await tools.bookstack_system_info();
    console.log('Token is valid');
    return true;
  } catch (error) {
    console.error('Token validation failed:', error.message);
    return false;
  }
};

// Refresh token if supported
const refreshToken = async () => {
  // Implementation depends on your BookStack setup
  // Some setups support token refresh
};
```

#### 2. Rate Limiting

**Issue**: Requests being rate limited

**Solutions**:
```javascript
// Implement exponential backoff
const rateLimitSafeRequest = async (requestFn, maxRetries = 3) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await requestFn();
    } catch (error) {
      if (error.status === 429 && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        console.log(`Rate limited, waiting ${delay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }
};

// Use batch operations to reduce API calls
const batchRequests = async (requests, batchSize = 5) => {
  const results = [];
  
  for (let i = 0; i < requests.length; i += batchSize) {
    const batch = requests.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch);
    results.push(...batchResults);
    
    // Add delay between batches
    if (i + batchSize < requests.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  return results;
};
```

#### 3. Content Synchronization Issues

**Issue**: Content getting out of sync between environments

**Solutions**:
```javascript
// Implement content versioning
const versionContent = async (pageId) => {
  const page = await tools.bookstack_pages_read({ id: pageId });
  const version = Date.now().toString();
  
  // Add version tag
  await tools.bookstack_pages_update({
    id: pageId,
    tags: [
      ...page.tags.filter(t => t.name !== 'version'),
      { name: 'version', value: version },
      { name: 'versioned_at', value: new Date().toISOString() }
    ]
  });
  
  return version;
};

// Implement conflict resolution
const resolveConflicts = async (localPage, remotePage) => {
  // Simple last-write-wins strategy
  const localTime = new Date(localPage.updated_at);
  const remoteTime = new Date(remotePage.updated_at);
  
  if (localTime > remoteTime) {
    return localPage;
  } else {
    return remotePage;
  }
};
```

#### 4. Performance Issues

**Issue**: Slow response times when dealing with large amounts of content

**Solutions**:
```javascript
// Implement pagination for large datasets
const getAllPagesEfficiently = async (bookId) => {
  const allPages = [];
  let offset = 0;
  const limit = 100;
  
  while (true) {
    const batch = await tools.bookstack_pages_list({
      filter: { book_id: bookId },
      count: limit,
      offset: offset
    });
    
    allPages.push(...batch.data);
    
    if (batch.data.length < limit) {
      break;
    }
    
    offset += limit;
  }
  
  return allPages;
};

// Use search instead of listing when possible
const findPagesEfficiently = async (criteria) => {
  const searchQuery = buildSearchQuery(criteria);
  
  const results = await tools.bookstack_search({
    query: searchQuery,
    count: 500
  });
  
  return results.data;
};
```

### Debug Mode

Enable debug mode for detailed logging:

```javascript
// Enable debug logging
process.env.LOG_LEVEL = 'debug';

// Add request/response logging
const debugRequest = (requestData) => {
  if (process.env.LOG_LEVEL === 'debug') {
    console.log('Request:', JSON.stringify(requestData, null, 2));
  }
};

const debugResponse = (responseData) => {
  if (process.env.LOG_LEVEL === 'debug') {
    console.log('Response:', JSON.stringify(responseData, null, 2));
  }
};
```

### Testing Your Setup

```javascript
// Comprehensive setup test
const testSetup = async () => {
  const tests = [
    { name: 'Connection', test: testConnection },
    { name: 'Authentication', test: testAuthentication },
    { name: 'Basic Operations', test: testBasicOperations },
    { name: 'Search Functionality', test: testSearch },
    { name: 'Permissions', test: testPermissions }
  ];
  
  const results = [];
  
  for (const test of tests) {
    try {
      await test.test();
      results.push({ name: test.name, status: 'passed' });
    } catch (error) {
      results.push({ name: test.name, status: 'failed', error: error.message });
    }
  }
  
  return results;
};

const testConnection = async () => {
  const info = await tools.bookstack_system_info();
  console.log('✓ Connection successful');
};

const testAuthentication = async () => {
  const books = await tools.bookstack_books_list({ count: 1 });
  console.log('✓ Authentication successful');
};

const testBasicOperations = async () => {
  // Create a test book
  const book = await tools.bookstack_books_create({
    name: 'Test Book',
    description: 'Test book for setup validation'
  });
  
  // Create a test page
  const page = await tools.bookstack_pages_create({
    book_id: book.id,
    name: 'Test Page',
    markdown: '# Test Page\n\nThis is a test page.'
  });
  
  // Clean up
  await tools.bookstack_pages_delete({ id: page.id });
  await tools.bookstack_books_delete({ id: book.id });
  
  console.log('✓ Basic operations successful');
};
```

---

This comprehensive guide covers the major patterns and use cases for the BookStack MCP Server. Each example is designed to be practical and adaptable to your specific needs. Remember to adapt the code examples to your environment and requirements.

For additional support, refer to the [BookStack API documentation](https://demo.bookstackapp.com/api/docs) and the [MCP specification](https://modelcontextprotocol.io/docs).