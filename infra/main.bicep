// AVD Dashboards — Azure Container Apps deployment.
//
// What this creates:
//   Log Analytics (for the app's own logs) · Container Apps environment
//   user-assigned managed identity · Key Vault (RBAC) · Postgres Flexible Server with
//   Entra-only auth · one container app for the web with EasyAuth, one for the worker.
//
// Nothing here stores a password: the app authenticates to Postgres with its managed
// identity, and connection secrets go in Key Vault.

targetScope = 'resourceGroup'

@description('Short name used as a prefix for every resource.')
@minLength(3)
@maxLength(12)
param name string = 'avddash'

@description('Location for all resources.')
param location string = resourceGroup().location

@description('Container image to run, e.g. ghcr.io/<owner>/avd-dashboards:v0.1.0')
param image string

@description('Entra app registration (client) ID used by Container Apps authentication.')
param authClientId string

@description('Client secret for that app registration. Stored in Key Vault, never in outputs.')
@secure()
param authClientSecret string

@description('Entra tenant that may sign in. Defaults to this subscription tenant.')
param authTenantId string = subscription().tenantId

@description('Entra object IDs that become owners without the one-time setup code.')
param bootstrapOwnerObjectIds array = []

@description('Object ID of the person or group that administers the Postgres server.')
param postgresAdminObjectId string

@description('Display name for that Postgres administrator.')
param postgresAdminName string

@description('Postgres SKU. Burstable is fine for a few thousand session hosts.')
param postgresSku string = 'Standard_B2s'

@description('Postgres storage in GB.')
param postgresStorageGb int = 64

@description('''
32-byte base64 key used to encrypt connection secrets stored in Postgres.
Leave empty and one is derived from the resource group id — deterministic, so a redeploy keeps
working, but generate your own for real use: openssl rand -base64 32
''')
@secure()
param appEncryptionKey string = ''

var suffix = uniqueString(resourceGroup().id)
var prefix = toLower('${name}${substring(suffix, 0, 5)}')
var dbName = 'avd'
var tags = { app: 'avd-dashboards', 'azd-env-name': name }

// ─── identity ───────────────────────────────────────────────────────────────────

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${prefix}-id'
  location: location
  tags: tags
}

// ─── observability ──────────────────────────────────────────────────────────────

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-logs'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

// ─── secrets ────────────────────────────────────────────────────────────────────

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: '${prefix}-kv'
  location: location
  tags: tags
  properties: {
    sku: { family: 'A', name: 'standard' }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    publicNetworkAccess: 'Enabled'
  }
}

resource authSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'easyauth-client-secret'
  properties: { value: authClientSecret }
}

// 32 bytes, base64 — either the caller's key or one derived from the resource group id.
var derivedKeyMaterial = '${uniqueString(resourceGroup().id, 'k1')}${uniqueString(resourceGroup().id, 'k2')}${uniqueString(resourceGroup().id, 'k3')}'
var encryptionKey = empty(appEncryptionKey) ? base64(substring(derivedKeyMaterial, 0, 32)) : appEncryptionKey

resource encryptionKeySecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'app-encryption-key'
  properties: { value: encryptionKey }
}

// Key Vault Secrets User — the app reads secrets, it never writes them.
resource vaultReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, identity.id, '4633458b-17de-408a-b874-0445c86b69e6')
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '4633458b-17de-408a-b874-0445c86b69e6'
    )
  }
}

// ─── database ───────────────────────────────────────────────────────────────────

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: '${prefix}-pg'
  location: location
  tags: tags
  sku: { name: postgresSku, tier: startsWith(postgresSku, 'Standard_B') ? 'Burstable' : 'GeneralPurpose' }
  properties: {
    version: '16'
    storage: { storageSizeGB: postgresStorageGb, autoGrow: 'Enabled' }
    backup: { backupRetentionDays: 14, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
    // Entra-only: there is no password to leak.
    authConfig: { activeDirectoryAuth: 'Enabled', passwordAuth: 'Disabled', tenantId: subscription().tenantId }
    network: { publicNetworkAccess: 'Enabled' }
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: dbName
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}

// Container Apps egress IPs are not fixed, so allow Azure services and rely on Entra auth.
resource allowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: postgres
  name: 'AllowAllAzureServices'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

resource pgAdmin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2024-08-01' = {
  parent: postgres
  name: postgresAdminObjectId
  properties: {
    principalName: postgresAdminName
    principalType: 'User'
    tenantId: subscription().tenantId
  }
  dependsOn: [database]
}

// The app identity also has to be a Postgres administrator so it can connect and migrate.
// Its principal id is only known once the deployment runs, and administrator resources need a
// name that is known up front — so deploy.sh adds it in a second step (see infra/deploy.sh).

// ─── container apps ─────────────────────────────────────────────────────────────

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${prefix}-env'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

var sharedEnv = [
  { name: 'NODE_ENV', value: 'production' }
  { name: 'AUTH_MODE', value: 'easyauth' }
  { name: 'HOST', value: '0.0.0.0' }
  { name: 'PORT', value: '3000' }
  { name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }
  { name: 'DATABASE_USE_ENTRA_AUTH', value: 'true' }
  {
    name: 'DATABASE_URL'
    value: 'postgres://${identity.name}@${postgres.properties.fullyQualifiedDomainName}:5432/${dbName}?sslmode=require'
  }
  { name: 'KEY_VAULT_URI', value: vault.properties.vaultUri }
  { name: 'APP_ENCRYPTION_KEY', secretRef: 'app-encryption-key' }
  { name: 'ALLOWED_TENANT_IDS', value: authTenantId }
  { name: 'EASYAUTH_CLIENT_ID', value: authClientId }
  { name: 'BOOTSTRAP_OWNER_OIDS', value: join(bootstrapOwnerObjectIds, ',') }
  { name: 'DEMO_MODE', value: 'false' }
  { name: 'LOG_LEVEL', value: 'info' }
]

var kvSecrets = [
  {
    name: 'app-encryption-key'
    keyVaultUrl: '${vault.properties.vaultUri}secrets/app-encryption-key'
    identity: identity.id
  }
  {
    name: 'easyauth-client-secret'
    keyVaultUrl: '${vault.properties.vaultUri}secrets/easyauth-client-secret'
    identity: identity.id
  }
]

resource web 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${prefix}-web'
  location: location
  tags: union(tags, { 'azd-service-name': 'web' })
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identity.id}': {} } }
  properties: {
    managedEnvironmentId: env.id
    configuration: {
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
      }
      secrets: kvSecrets
    }
    template: {
      containers: [
        {
          name: 'web'
          image: image
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: concat(sharedEnv, [
            { name: 'APP_ROLE', value: 'web' }
            { name: 'PUBLIC_BASE_URL', value: 'https://${prefix}-web.${env.properties.defaultDomain}' }
          ])
          probes: [
            { type: 'Liveness', httpGet: { path: '/healthz', port: 3000 }, periodSeconds: 30 }
            { type: 'Readiness', httpGet: { path: '/readyz', port: 3000 }, periodSeconds: 10 }
          ]
        }
      ]
      scale: { minReplicas: 1, maxReplicas: 3 }
    }
  }
  dependsOn: [vaultReader, pgAdmin]
}

// Every request is terminated by the platform auth sidecar, so the app can trust
// X-MS-CLIENT-PRINCIPAL. Turning this off would let anyone forge that header.
resource auth 'Microsoft.App/containerApps/authConfigs@2024-03-01' = {
  parent: web
  name: 'current'
  properties: {
    platform: { enabled: true }
    globalValidation: {
      unauthenticatedClientAction: 'RedirectToLoginPage'
      redirectToProvider: 'azureactivedirectory'
      excludedPaths: ['/healthz', '/readyz']
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          clientId: authClientId
          clientSecretSettingName: 'easyauth-client-secret'
          openIdIssuer: '${environment().authentication.loginEndpoint}${authTenantId}/v2.0'
        }
        validation: {
          allowedAudiences: ['api://${authClientId}', authClientId]
          defaultAuthorizationPolicy: { allowedApplications: [] }
        }
      }
    }
    login: { tokenStore: { enabled: true } }
  }
}

resource worker 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${prefix}-worker'
  location: location
  tags: union(tags, { 'azd-service-name': 'worker' })
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identity.id}': {} } }
  properties: {
    managedEnvironmentId: env.id
    configuration: { secrets: kvSecrets }
    template: {
      containers: [
        {
          name: 'worker'
          image: image
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: concat(sharedEnv, [{ name: 'APP_ROLE', value: 'worker' }])
        }
      ]
      scale: { minReplicas: 1, maxReplicas: 2 }
    }
  }
  dependsOn: [vaultReader, pgAdmin]
}

output webUrl string = 'https://${web.properties.configuration.ingress.fqdn}'
output identityClientId string = identity.properties.clientId
output identityPrincipalId string = identity.properties.principalId
output keyVaultName string = vault.name
output postgresHost string = postgres.properties.fullyQualifiedDomainName
output consentRedirectUri string = 'https://${web.properties.configuration.ingress.fqdn}/api/connections/consent/callback'
