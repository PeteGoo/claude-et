import { Octokit } from 'octokit'
import { settings } from './db.js'

function getClient() {
  const token = settings.get('githubToken')
  if (!token) throw new Error('GitHub token not configured. Add it in Settings.')
  return new Octokit({ auth: token })
}

export async function listRepos() {
  const octokit = getClient()
  const org = settings.get('githubOrg')

  const allRepos = []

  // Personal repos
  const { data: personalRepos } = await octokit.rest.repos.listForAuthenticatedUser({
    per_page: 100,
    sort: 'updated',
    type: 'owner',
  })
  allRepos.push(...personalRepos.map(r => ({
    name: r.name,
    fullName: r.full_name,
    cloneUrl: r.clone_url,
    private: r.private,
    org: null,
    updatedAt: r.updated_at,
  })))

  // Org repos if configured
  if (org) {
    try {
      const { data: orgRepos } = await octokit.rest.repos.listForOrg({
        org,
        per_page: 100,
        sort: 'updated',
        type: 'all',
      })
      allRepos.push(...orgRepos.map(r => ({
        name: r.name,
        fullName: r.full_name,
        cloneUrl: r.clone_url,
        private: r.private,
        org,
        updatedAt: r.updated_at,
      })))
    } catch (err) {
      console.warn(`Could not list org repos for ${org}:`, err.message)
    }
  }

  return allRepos.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
}

export async function createRepo(name, isPrivate = true) {
  const octokit = getClient()
  const org = settings.get('githubOrg')

  let repo
  if (org) {
    const { data } = await octokit.rest.repos.createInOrg({
      org,
      name,
      private: isPrivate,
      auto_init: false,
    })
    repo = data
  } else {
    const { data } = await octokit.rest.repos.createForAuthenticatedUser({
      name,
      private: isPrivate,
      auto_init: false,
    })
    repo = data
  }

  return {
    name: repo.name,
    fullName: repo.full_name,
    cloneUrl: repo.clone_url,
    private: repo.private,
    org: org || null,
  }
}

export async function validateToken() {
  try {
    const octokit = getClient()
    const { data } = await octokit.rest.users.getAuthenticated()
    return { valid: true, login: data.login, name: data.name }
  } catch (err) {
    return { valid: false, error: err.message }
  }
}
