export type Tab = 'shop' | 'orders' | 'profile';

export interface User {
  id: string;
  telegramId: string;
  username?: string | null;
  firstName: string;
  lastName?: string | null;
  photoUrl?: string | null;
  isActive: boolean;
  balanceFen: number;
}

export interface Variant {
  id: string;
  name: string;
  sku?: string;
  priceFen: number;
  stock: number;
  sold?: number;
  maxPerOrder: number;
}

export interface Category {
  id: string;
  name: string;
  slug: string;
  position?: number;
}

export interface Product {
  id: string;
  title: string;
  slug: string;
  description?: string | null;
  instructions?: string | null;
  imageUrl?: string | null;
  category?: Category | null;
  variants: Variant[];
}

export type OrderStatus =
  | 'pending_payment'
  | 'payment_confirming'
  | 'paid'
  | 'fulfilling'
  | 'completed'
  | 'payment_expired'
  | 'canceled'
  | 'fulfillment_failed'
  | 'refunded';

export interface PaymentInstructions {
  mode?: string;
  method?: string;
  label?: string;
  amountUnit?: string;
  network?: string | null;
  qrContent?: string;
  address?: string | null;
}

export interface PaymentSummary {
  provider?: string;
  status?: string;
  checkoutUrl?: string | null;
  chain?: string | null;
  tokenId?: string | null;
  payableAmount?: string | null;
  payAddress?: string | null;
  expiresAt?: string | null;
  serverTime?: string | null;
  paymentInstructions?: PaymentInstructions | null;
}

export interface Order {
  orderNo: string;
  productTitle: string;
  variantName: string;
  quantity: number;
  totalPriceFen: number;
  currency?: string;
  status: OrderStatus;
  fulfillmentStatus?: string;
  createdAt: string;
  paidAt?: string | null;
  failureReason?: string | null;
  payment?: PaymentSummary;
  cards?: Array<{ code: string; password?: string; note?: string }>;
}

export interface Recharge {
  rechargeNo: string;
  amountFen: number;
  status: OrderStatus | string;
  payment?: PaymentSummary;
}

export interface PublicConfig {
  version: string;
  supportUrl?: string | null;
  paymentProvider: string;
  paymentConfigured: boolean;
  paymentReady: boolean;
  paymentEnabled: boolean;
  paymentChain?: string;
  paymentToken?: string;
}

export interface Session {
  accessToken: string;
  user: User;
}

export type ApiErrorShape = { error?: { message?: string; code?: string } };
