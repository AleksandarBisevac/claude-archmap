targetScope = 'resourceGroup'

@description('Azure region for the fleet exports')
param location string = resourceGroup().location
param storageName string

resource storage 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: storageName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-01-01' = {
  parent: storage
  name: 'default'
}

// storage in a comment or in 'storage' is not a reference
resource exports 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: blobService
  name: 'exports'
  dependsOn: [
    storage
  ]
  properties: {
    metadata: {
      account: storage.name
    }
  }
}

output storageId string = storage.id
output containerName string = exports.name
