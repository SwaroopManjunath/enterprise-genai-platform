terraform {
  required_version = ">= 1.9"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }

  # State holds resource ids and, if anyone ever adds them, secrets: keep it in an encrypted, access
  # controlled store. Configure with `terraform init -backend-config=backend.hcl` (see README).
  backend "azurerm" {}
}

provider "azurerm" {
  features {
    key_vault {
      # A vault holding every secret the platform uses must not be removable by a stray destroy.
      purge_soft_delete_on_destroy = false
    }
  }
  subscription_id = var.subscription_id
}
