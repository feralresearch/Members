const {flowRight} = require('lodash');
const {mapKeyValues, mapQuery} = require('@nexes/mongo-utils');
const DomainEvents = require('@tryghost/domain-events');
const OfferCodeChangeEvent = require('../domain/events/OfferCodeChange');
const Offer = require('../domain/models/Offer');
const OfferStatus = require('../domain/models/OfferStatus');

const statusTransformer = mapKeyValues({
    key: {
        from: 'status',
        to: 'active'
    },
    values: [{
        from: 'active',
        to: true
    }, {
        from: 'archived',
        to: false
    }]
});

const rejectNonStatusTransformer = input => mapQuery(input, function (value, key) {
    if (key !== 'status') {
        return;
    }

    return {
        [key]: value
    };
});

const mongoTransformer = flowRight(statusTransformer, rejectNonStatusTransformer);

/**
 * @typedef {object} BaseOptions
 * @prop {import('knex').Transaction} transacting
 */

/**
 * @extends BaseOptions
 * @typedef {object} ListOptions
 * @prop {string} filter
 */

/**
 * @param {any} json
 * @returns {Offer.OfferCreateProps}
 */
function toDomain(json) {
    return {
        id: json.id,
        name: json.name,
        code: json.code,
        display_title: json.portal_title,
        display_description: json.portal_description,
        type: json.discount_type === 'amount' ? 'fixed' : 'percent',
        amount: json.discount_amount,
        cadence: json.interval,
        currency: json.currency,
        duration: json.duration,
        duration_in_months: json.duration_in_months,
        stripe_coupon_id: json.stripe_coupon_id,
        status: json.active ? 'active' : 'archived',
        tier: {
            id: json.product.id,
            name: json.product.name
        }
    };
}

class OfferRepository {
    /**
     * @param {{forge: (data: object) => import('bookshelf').Model<Offer.OfferProps>}} OfferModel
     * @param {import('@tryghost/members-stripe-service')} stripeAPIService
     */
    constructor(OfferModel, stripeAPIService) {
        /** @private */
        this.OfferModel = OfferModel;
        /** @private */
        this.stripeAPIService = stripeAPIService;
    }

    /**
     * @template T
     * @param {(t: import('knex').Transaction) => Promise<T>} cb
     * @returns {Promise<T>}
     */
    async createTransaction(cb) {
        return this.OfferModel.transaction(cb);
    }

    /**
     * @param {string} name
     * @param {BaseOptions} [options]
     * @returns {Promise<boolean>}
     */
    async existsByName(name, options) {
        const model = await this.OfferModel.findOne({name}, options);
        if (!model) {
            return false;
        }
        return true;
    }

    /**
     * @param {string} code
     * @param {BaseOptions} [options]
     * @returns {Promise<boolean>}
     */
    async existsByCode(code, options) {
        const model = await this.OfferModel.findOne({code}, options);
        if (!model) {
            return false;
        }
        return true;
    }

    /**
     * @param {string} id
     * @param {BaseOptions} [options]
     * @returns {Promise<Offer>}
     */
    async getById(id, options) {
        const model = await this.OfferModel.findOne({id}, {
            ...options,
            withRelated: ['product']
        });

        const json = model.toJSON();

        return Offer.create(toDomain(json));
    }

    /**
     * @param {ListOptions} options
     * @returns {Promise<Offer[]>}
     */
    async getAll(options) {
        const models = await this.OfferModel.findAll({
            ...options,
            mongoTransformer,
            withRelated: ['product']
        });
        return Promise.all(models.toJSON().map(toDomain).map(Offer.create));
    }

    /**
     * @param {Offer} offer
     * @param {BaseOptions} [options]
     * @returns {Promise<void>}
     */
    async save(offer, options) {
        /** @type any */
        const data = {
            id: offer.id,
            name: offer.name.value,
            code: offer.code.value,
            portal_title: offer.displayTitle.value,
            portal_description: offer.displayDescription.value,
            discount_type: offer.type.value === 'fixed' ? 'amount' : 'percent',
            discount_amount: offer.amount.value,
            interval: offer.cadence.value,
            product_id: offer.tier.id,
            duration: offer.duration.value.type,
            duration_in_months: offer.duration.value.type === 'repeating' ? offer.duration.value.months : null,
            currency: offer.currency ? offer.currency.value : null,
            active: offer.status.equals(OfferStatus.create('active'))
        };

        if (offer.codeChanged || offer.isNew) {
            const event = OfferCodeChangeEvent.create({
                offerId: offer.id,
                previousCode: offer.oldCode,
                currentCode: offer.code
            });
            DomainEvents.dispatch(event);
        }

        if (offer.isNew) {
            /** @type {import('stripe').Stripe.CouponCreateParams} */
            const coupon = {
                name: offer.name.value,
                duration: offer.duration.value.type
            };

            if (offer.duration.value.type === 'repeating') {
                coupon.duration_in_months = offer.duration.value.months;
            }

            if (offer.type.value === 'percent') {
                coupon.percent_off = offer.amount.value;
            } else {
                coupon.amount_off = offer.amount.value;
                coupon.currency = offer.currency.value;
            }

            const couponData = await this.stripeAPIService.createCoupon(coupon);
            data.stripe_coupon_id = couponData.id;
            await this.OfferModel.add(data, options);
        } else {
            await this.OfferModel.edit(data, {...options, id: data.id});
        }
    }
}

module.exports = OfferRepository;